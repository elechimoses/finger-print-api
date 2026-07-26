import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://megxtwqfhyklkfpyrety.supabase.co';
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_JPrI8PGFgT_YmVl7wEPzjg_zQgPO5RU';

const supabase = createClient(supabaseUrl, supabaseKey);

async function testConnection() {
  console.log('Testing connection to Supabase...');
  console.log('URL:', supabaseUrl);
  
  // Try querying cards table
  const { data, error } = await supabase.from('cards').select('*').limit(1);
  if (error) {
    console.error('Error querying cards table:', error);
  } else {
    console.log('Successfully queried cards table! Result:', data);
  }
}

testConnection();
