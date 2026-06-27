const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

async function test() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  console.log('SUPABASE URL:', url);
  console.log('SUPABASE KEY LENGTH:', key ? key.length : 0);

  if (!url || !key) {
    console.log('No Supabase credentials');
    return;
  }

  const supabase = createClient(url, key);
  try {
    const { data, error } = await supabase.from('gastos').select('*').limit(5);
    if (error) {
      console.log('Error fetching gastos:', error);
    } else {
      console.log('Successfully fetched gastos:', data.length, 'records found');
      console.log('Records:', data);
    }
  } catch (e) {
    console.log('Exception:', e.message);
  }
}

test();
