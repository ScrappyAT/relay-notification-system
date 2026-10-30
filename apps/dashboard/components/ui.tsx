"use client";
import { useState } from "react";
import { Activity, Check, CircleAlert, Copy, Inbox, LoaderCircle, Mail, MessageSquare, RefreshCw } from "lucide-react";
import type { Notification, Overview } from "../lib/types";

export const number = (n: number) => new Intl.NumberFormat("en-US").format(n);
export const statusLabel = (status: string) => status.replaceAll("_", " ");
export const timestamp = (value: string) => new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function Badge({ status }: { status: string }) {
  const tone = ["healthy", "provider_accepted", "delivered", "enabled", "processed"].includes(status) ? "green" : ["failed", "unavailable", "disabled"].includes(status) ? "red" : ["outcome_unknown", "suppressed", "processing", "delayed"].includes(status) ? "amber" : "gray";
  return <span className={`badge ${tone}`}><span className="status-dot" />{statusLabel(status)}</span>;
}
export function Loading({ label = "Loading live data…" }: { label?: string }) {
  return <div className="state" role="status"><LoaderCircle size={22} className="animate-spin text-emerald-600" /><p>{label}</p></div>;
}
export function Empty({ title = "Nothing here yet", body = "Notifications will appear here when you send your first request." }: { title?: string; body?: string }) {
  return <div className="state"><div className="empty-icon"><Inbox size={24} /></div><h3>{title}</h3><p>{body}</p></div>;
}
export function ErrorState({ message, retry }: { message?: string; retry?: () => void }) {
  if (!message) return null;
  return <div className="error-state" role="alert"><CircleAlert size={18} /><span>{message}</span>{retry && <button onClick={retry} className="text-button"><RefreshCw size={14} />Retry</button>}</div>;
}
export function Notice({ children }: { children: React.ReactNode }) {
  return <div className="notice"><Activity size={17} /><div>{children}</div></div>;
}
function CopyId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  return <button className="icon-button" title={error ? "Copy unavailable" : copied ? "Copied" : `Copy notification ID ${id}`} aria-label={copied ? "Notification ID copied" : `Copy notification ID ${id}`} onClick={async () => {
    try { await navigator.clipboard.writeText(id); setCopied(true); setError(false); }
    catch { setError(true); }
  }}>{copied ? <Check size={16}/> : <Copy size={15}/>}</button>;
}
export function NotificationTable({ rows, compact = false }: { rows: Notification[]; compact?: boolean }) {
  if (!rows.length) return <Empty />;
  return <div className="table-scroll"><table><thead><tr><th>Recipient</th>{!compact && <th>Tenant</th>}<th>Channel</th><th>Status</th>{!compact && <th>Retries</th>}<th>Created</th><th><span className="sr-only">Notification ID</span></th></tr></thead><tbody>{rows.map(n => <tr key={n.id}>
    <td><div className="recipient-cell"><div className={`channel-icon ${n.channel}`}>{n.channel === "email" ? <Mail size={17} /> : <MessageSquare size={17} />}</div><div><span className="recipient">{n.recipient}</span><span className="row-id" title={n.id}>{n.id.slice(0, 8)}…</span></div></div></td>
    {!compact && <td>{n.customer_name}</td>}<td><span className="channel-text">{n.channel === "email" ? "Email" : "SMS"}</span></td><td><Badge status={n.status} /></td>{!compact && <td>{n.retry_count}</td>}<td className="date-cell">{timestamp(n.created_at)}</td><td><CopyId id={n.id}/></td>
  </tr>)}</tbody></table></div>;
}

export function ActivityChart({ data }: { data: Overview }) {
  const max = Math.max(4, ...data.activity.map(d => Math.max(d.email, d.sms)));
  const ceiling = Math.ceil(max / 4) * 4;
  const width = 850, height = 210, left = 44, top = 16, bottom = 184;
  const x = (i: number) => left + i * (width - left - 18) / Math.max(data.activity.length - 1, 1);
  const y = (value: number) => bottom - value / ceiling * (bottom - top);
  const points = (channel: "email" | "sms") => data.activity.map((d, i) => `${x(i)},${y(d[channel])}`).join(" ");
  return <div className="chart-wrap"><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Daily notification requests for ${data.days} days, UTC. ${data.email} emails and ${data.sms} SMS.`}>
    <defs><linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#199c77" stopOpacity=".15"/><stop offset="100%" stopColor="#199c77" stopOpacity="0"/></linearGradient></defs>
    {[0, 1, 2, 3, 4].map(i => <g key={i}><line x1={left} x2={width - 12} y1={y(ceiling / 4 * i)} y2={y(ceiling / 4 * i)} stroke="#e9edec" strokeDasharray="3 4"/><text x={left - 13} y={y(ceiling / 4 * i) + 4} textAnchor="end" className="chart-label">{number(ceiling / 4 * i)}</text></g>)}
    <polygon points={`${left},${bottom} ${points("email")} ${x(data.activity.length - 1)},${bottom}`} fill="url(#chart-fill)" />
    <polyline points={points("email")} fill="none" stroke="#179b75" strokeWidth="2.5" strokeLinejoin="round" />
    <polyline points={points("sms")} fill="none" stroke="#8b97d8" strokeWidth="2.5" strokeLinejoin="round" />
    {data.activity.map((d, i) => <g key={d.day}><circle cx={x(i)} cy={y(d.email)} r="3.4" fill="#179b75"><title>{d.day}: {d.email} emails, {d.sms} SMS</title></circle><circle cx={x(i)} cy={y(d.sms)} r="3" fill="#8b97d8"><title>{d.day}: {d.sms} SMS</title></circle>{(data.activity.length <= 7 || i % 5 === 0 || i === data.activity.length - 1) && <text x={x(i)} y={205} textAnchor="middle" className="chart-label">{new Date(`${d.day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}</text>}</g>)}
  </svg>{data.total === 0 && <div className="chart-empty">No requests in this period</div>}</div>;
}
export function Metric({ label, value, icon, detail, tone = "green" }: { label: string; value: string; icon: React.ReactNode; detail: string; tone?: string }) {
  return <article className="metric-card"><div className="metric-heading"><span>{label}</span><span className={`metric-icon ${tone}`}>{icon}</span></div><strong>{value}</strong><div className="metric-detail"><span className={`tiny-dot ${tone}`} />{detail}</div></article>;
}
export function Success({ children }: { children: React.ReactNode }) {
  return <div className="success-state" role="status"><Check size={18} /><div>{children}</div></div>;
}
