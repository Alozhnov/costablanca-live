import supabase from './_lib/supabase.js';
import stripe from './_lib/stripe.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { booking_id, customer_email } = req.body;

  if (!booking_id || !customer_email) {
    return res.status(400).json({ error: 'booking_id and customer_email are required' });
  }

  // Find booking and verify email
  const { data: booking, error: findError } = await supabase
    .from('bookings')
    .select('id, customer_email, status, payment_status, stripe_payment_intent_id, availability_id, guest_count, availability(date)')
    .eq('id', booking_id)
    .single();

  if (findError || !booking) {
    return res.status(404).json({ error: 'Booking not found' });
  }

  if (booking.customer_email.toLowerCase() !== customer_email.toLowerCase()) {
    return res.status(403).json({ error: 'Email does not match booking' });
  }

  if (booking.status === 'cancelled' || booking.status === 'refunded') {
    return res.status(400).json({ error: 'Booking is already cancelled' });
  }

  // Check 24-hour cancellation window
  const tourDate = new Date(booking.availability?.date + 'T00:00:00Z');
  const now = new Date();
  const hoursUntilTour = (tourDate - now) / (1000 * 60 * 60);

  if (hoursUntilTour < 24) {
    return res.status(400).json({ error: 'Cancellations must be made at least 24 hours before the tour' });
  }

  // Cancel or refund via Stripe
  if (booking.stripe_payment_intent_id) {
    try {
      if (booking.payment_status === 'authorized') {
        // Not yet captured — just cancel the payment intent (releases hold)
        await stripe.paymentIntents.cancel(booking.stripe_payment_intent_id);
      } else if (booking.payment_status === 'captured') {
        // Already charged — issue refund
        await stripe.refunds.create({ payment_intent: booking.stripe_payment_intent_id });
      }
    } catch (err) {
      return res.status(500).json({ error: 'Failed to process cancellation with payment provider' });
    }
  }

  // Update booking status
  await supabase
    .from('bookings')
    .update({
      status: 'cancelled',
      payment_status: booking.payment_status === 'captured' ? 'refunded' : 'cancelled',
      cancelled_at: new Date().toISOString(),
    })
    .eq('id', booking.id);

  // Restore availability spots
  const { data: avail } = await supabase
    .from('availability')
    .select('spots_remaining')
    .eq('id', booking.availability_id)
    .single();

  if (avail) {
    await supabase
      .from('availability')
      .update({ spots_remaining: avail.spots_remaining + booking.guest_count })
      .eq('id', booking.availability_id);
  }

  return res.status(200).json({ success: true, status: 'cancelled' });
}
