import pg from "pg";
import { env } from "../config/env.js";

export const pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: env.DB_POOL_MAX,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
});

pool.on("error", (err) => {
    console.warn("Unexpected error on idle PostgreSQL client:", err.message);
});
