import { buffer } from 'micro';
import stripe from './_lib/stripe.js';
import supabase from './_lib/supabase.js';
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

// Disable body parsing so we can verify the Stripe signature
export const config = {
  api: { bodyParser: false },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const buf = await buffer(req);
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(buf, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).json({ error: `Webhook signature verification failed` });
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const bookingId = session.metadata?.booking_id;
      if (!bookingId) break;

      // Update booking status
      await supabase
        .from('bookings')
        .update({
          status: 'confirmed',
          payment_status: 'authorized',
          stripe_payment_intent_id: session.payment_intent,
        })
        .eq('id', bookingId);

      // Send confirmation email
      const { data: booking } = await supabase
        .from('bookings')
        .select('*, tours(name, duration)')
        .eq('id', bookingId)
        .single();

      if (booking && process.env.RESEND_API_KEY) {
        const siteUrl = process.env.SITE_URL || 'https://costablanca-live.vercel.app';
        const cancelUrl = `${siteUrl}/booking-cancelled.html?booking_id=${bookingId}&email=${encodeURIComponent(booking.customer_email)}`;

        await resend.emails.send({
          from: 'Costa Blanca Tour <bookings@costablancatour.com>',
          to: booking.customer_email,
          subject: 'Your Costa Blanca Tour is Reserved!',
          html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 2rem; color: #2f2117;">
              <h1 style="font-size: 1.6rem; margin-bottom: 0.5rem;">Tour Reserved!</h1>
              <p style="color: #7a6b5d; line-height: 1.7;">Hi ${booking.customer_name}, your tour has been reserved. Your card has been authorized but will only be charged 24 hours before the tour.</p>

              <div style="background: #faf6f1; border-radius: 12px; padding: 1.25rem; margin: 1.5rem 0;">
                <p style="margin: 0 0 0.5rem;"><strong>Tour:</strong> ${booking.tours?.name || 'Costa Blanca Tour'}</p>
                <p style="margin: 0 0 0.5rem;"><strong>Date:</strong> ${session.metadata.date}</p>
                <p style="margin: 0 0 0.5rem;"><strong>Guests:</strong> ${booking.guest_count}</p>
                <p style="margin: 0 0 0.5rem;"><strong>Total:</strong> €${(booking.total_cents / 100).toFixed(2)}</p>
                <p style="margin: 0;"><strong>Duration:</strong> ${booking.tours?.duration || ''}</p>
              </div>

              <p style="color: #7a6b5d; line-height: 1.7; font-size: 0.92rem;">Free cancellation up to 24 hours before. <a href="${cancelUrl}" style="color: #d4853b;">Cancel booking</a></p>

              <hr style="border: none; border-top: 1px solid #eee; margin: 1.5rem 0;" />
              <p style="color: #aaa; font-size: 0.8rem;">Costa Blanca Tour · Small-group tours from Alicante</p>
            </div>
          `,
        }).catch(() => {}); // Don't fail the webhook if email fails
      }
      break;
    }

    case 'payment_intent.canceled': {
      const intent = event.data.object;
      // Find booking by payment intent ID and cancel it
      const { data: booking } = await supabase
        .from('bookings')
        .select('id, availability_id, guest_count')
        .eq('stripe_payment_intent_id', intent.id)
        .single();

      if (booking) {
        await supabase
          .from('bookings')
          .update({ status: 'cancelled', payment_status: 'cancelled', cancelled_at: new Date().toISOString() })
          .eq('id', booking.id);

        // Restore spots
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
      }
      break;
    }

    case 'charge.refunded': {
      const charge = event.data.object;
      await supabase
        .from('bookings')
        .update({ status: 'refunded', payment_status: 'refunded' })
        .eq('stripe_payment_intent_id', charge.payment_intent);
      break;
    }
  }

  return res.status(200).json({ received: true });
}
