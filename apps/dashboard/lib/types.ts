export type Channel = "email" | "sms";
export interface Customer { id: string; name: string }
export interface Notification {
  id: string; customer_id: string; customer_name: string; recipient: string;
  channel: Channel; status: string; retry_count: number; created_at: string; updated_at: string;
}
export interface History { notifications: Notification[]; total: number; page: number; limit: number }
export interface Overview {
  total: number; accepted: number; delivered: number; failed: number; unknown: number;
  suppressed: number; in_flight: number; email: number; sms: number;
  activity: { day: string; email: number; sms: number }[];
  sampledAt: string; days: number;
}
export interface Preference { id: string; recipient: string; channel: Channel; enabled: boolean; updated_at: string }
export interface Monitoring {
  api: string; database: string; redis: string;
  outbox: { pending: number; failed: number; oldest_seconds: number } | null;
  queues: { channel: string; waiting: number; active: number; delayed: number; failed: number; completed: number }[] | null;
  uptimeSeconds: number; totalRequests: number; serverErrors: number; redisReconnects: number;
  pool: { total: number; idle: number; waiting: number; max: number };
  sampledAt: string; scope: string;
}
