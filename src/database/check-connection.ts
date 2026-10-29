import { pool } from "./pool.js";

async function checkConnection() {
    try {
        const result = await pool.query(`
      SELECT
        current_database() AS database,
        current_user AS username,
        version() AS postgres_version
    `);

        console.log("PostgreSQL connection successful!");
        console.log("Database:", result.rows[0].database);
        console.log("User:", result.rows[0].username);
        console.log("PostgreSQL:", result.rows[0].postgres_version);
    } catch (error) {
        console.error("PostgreSQL connection failed:", error);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
}

checkConnection();