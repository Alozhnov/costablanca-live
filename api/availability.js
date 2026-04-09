import supabase from './_lib/supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { tour_slug, month } = req.query;

  if (!tour_slug) {
    return res.status(400).json({ error: 'tour_slug is required' });
  }

  // Look up tour by slug
  const { data: tour, error: tourError } = await supabase
    .from('tours')
    .select('id, name, price_cents, max_guests')
    .eq('slug', tour_slug)
    .eq('active', true)
    .single();

  if (tourError || !tour) {
    return res.status(404).json({ error: 'Tour not found' });
  }

  // Build date range filter
  let query = supabase
    .from('availability')
    .select('id, date, spots_remaining')
    .eq('tour_id', tour.id)
    .eq('status', 'open')
    .gt('spots_remaining', 0)
    .gt('date', new Date().toISOString().split('T')[0])
    .order('date', { ascending: true });

  if (month) {
    // Filter to specific month e.g. "2026-04"
    const start = `${month}-01`;
    const endDate = new Date(start);
    endDate.setMonth(endDate.getMonth() + 1);
    const end = endDate.toISOString().split('T')[0];
    query = query.gte('date', start).lt('date', end);
  }

  const { data: dates, error: dateError } = await query;

  if (dateError) {
    return res.status(500).json({ error: 'Failed to fetch availability' });
  }

  return res.status(200).json({
    tour: {
      slug: tour_slug,
      name: tour.name,
      price_cents: tour.price_cents,
      max_guests: tour.max_guests,
    },
    dates: dates || [],
  });
}
