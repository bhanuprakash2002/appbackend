const { Pool } = require("pg");
require("dotenv").config();

const pg = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false },
});

async function run() {
  try {
    await pg.query(`ALTER TABLE fcm_registry DROP CONSTRAINT IF EXISTS fcm_registry_phone_e164_fkey;`);
    console.log("Dropped fcm_registry_phone_e164_fkey");
  } catch (e) {
    console.log("fcm_registry error: ", e.message);
  }

  try {
    await pg.query(`ALTER TABLE user_language_prefs DROP CONSTRAINT IF EXISTS user_language_prefs_identity_fkey;`);
    console.log("Dropped user_language_prefs_identity_fkey");
  } catch (e) {
    console.log("user_language_prefs error: ", e.message);
  }

  process.exit(0);
}
run();
