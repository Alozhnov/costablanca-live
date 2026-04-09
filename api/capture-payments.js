import supabase from './_lib/supabase.js';
import stripe from './_lib/stripe.js';

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify cron secret if set (optional security layer)
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Find confirmed bookings where tour date is tomorrow
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];

  const { data: bookings, error } = await supabase
    .from('bookings')
    .select('id, stripe_payment_intent_id, total_cents, availability(date)')
    .eq('status', 'confirmed')
    .eq('payment_status', 'authorized');

  if (error) {
    return res.status(500).json({ error: 'Failed to query bookings' });
  }

  const toCapture = (bookings || []).filter(b => {
    const bookingDate = b.availability?.date;
    return bookingDate === tomorrowStr;
  });

  const results = [];

  for (const booking of toCapture) {
    if (!booking.stripe_payment_intent_id) continue;

    try {
      await stripe.paymentIntents.capture(booking.stripe_payment_intent_id);

      await supabase
        .from('bookings')
        .update({ payment_status: 'captured' })
        .eq('id', booking.id);

      results.push({ id: booking.id, status: 'captured' });
    } catch (err) {
      results.push({ id: booking.id, status: 'failed', error: err.message });
    }
  }

  return res.status(200).json({
    date: tomorrowStr,
    processed: results.length,
    results,
  });
}
