import { pool } from "../database/pool.js";

export class CustomerRepository {
  async findById(id: string) {
    const result = await pool.query(
      "SELECT * FROM customers WHERE id = $1",
      [id]
    );
    return result.rows[0] || null;
  }

  async create(name: string) {
    const result = await pool.query(
      "INSERT INTO customers (name) VALUES ($1) RETURNING *",
      [name]
    );
    return result.rows[0];
  }
}
