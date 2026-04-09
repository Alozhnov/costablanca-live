import supabase from './_lib/supabase.js';
import stripe from './_lib/stripe.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { tour_slug, date, guest_count, customer_name, customer_email, customer_phone } = req.body;

  // Validate required fields
  if (!tour_slug || !date || !guest_count || !customer_name || !customer_email) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  if (guest_count < 1 || guest_count > 11) {
    return res.status(400).json({ error: 'Guest count must be between 1 and 11' });
  }

  // Check tour date is in the future
  const tourDate = new Date(date + 'T00:00:00Z');
  if (tourDate <= new Date()) {
    return res.status(400).json({ error: 'Tour date must be in the future' });
  }

  // Look up tour
  const { data: tour, error: tourError } = await supabase
    .from('tours')
    .select('id, name, price_cents, currency, max_guests')
    .eq('slug', tour_slug)
    .eq('active', true)
    .single();

  if (tourError || !tour) {
    return res.status(404).json({ error: 'Tour not found' });
  }

  // Check availability
  const { data: availability, error: availError } = await supabase
    .from('availability')
    .select('id, spots_remaining')
    .eq('tour_id', tour.id)
    .eq('date', date)
    .eq('status', 'open')
    .single();

  if (availError || !availability) {
    return res.status(400).json({ error: 'No availability for this date' });
  }

  if (availability.spots_remaining < guest_count) {
    return res.status(400).json({
      error: `Only ${availability.spots_remaining} spots remaining for this date`,
    });
  }

  const totalCents = tour.price_cents * guest_count;

  // Create booking record
  const { data: booking, error: bookingError } = await supabase
    .from('bookings')
    .insert({
      tour_id: tour.id,
      availability_id: availability.id,
      customer_name,
      customer_email,
      customer_phone: customer_phone || null,
      guest_count,
      total_cents: totalCents,
      currency: tour.currency,
      status: 'pending',
      payment_status: 'pending',
    })
    .select('id')
    .single();

  if (bookingError) {
    return res.status(500).json({ error: 'Failed to create booking' });
  }

  // Decrement spots
  const { error: updateError } = await supabase
    .from('availability')
    .update({ spots_remaining: availability.spots_remaining - guest_count })
    .eq('id', availability.id);

  if (updateError) {
    // Rollback booking
    await supabase.from('bookings').delete().eq('id', booking.id);
    return res.status(500).json({ error: 'Failed to update availability' });
  }

  // Create Stripe Checkout Session
  const siteUrl = process.env.SITE_URL || 'https://costablanca-live.vercel.app';

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_intent_data: {
        capture_method: 'manual', // Authorize only, capture later
      },
      customer_email,
      line_items: [
        {
          price_data: {
            currency: tour.currency,
            product_data: {
              name: tour.name,
              description: `${date} · ${guest_count} guest${guest_count > 1 ? 's' : ''}`,
            },
            unit_amount: tour.price_cents,
          },
          quantity: guest_count,
        },
      ],
      metadata: {
        booking_id: booking.id,
        tour_slug,
        date,
        guest_count: String(guest_count),
      },
      success_url: `${siteUrl}/booking-confirmed.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/#packages`,
    });

    // Store session ID on booking
    await supabase
      .from('bookings')
      .update({ stripe_session_id: session.id })
      .eq('id', booking.id);

    return res.status(200).json({ url: session.url });
  } catch (stripeError) {
    // Rollback: restore spots and delete booking
    await supabase
      .from('availability')
      .update({ spots_remaining: availability.spots_remaining })
      .eq('id', availability.id);
    await supabase.from('bookings').delete().eq('id', booking.id);

    return res.status(500).json({ error: 'Failed to create checkout session' });
  }
}
