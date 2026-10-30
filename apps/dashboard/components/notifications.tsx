"use client";
import { useState } from "react";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { query, useResource } from "../lib/api";
import type { History } from "../lib/types";
import { Empty, ErrorState, Loading, NotificationTable, number, statusLabel } from "./ui";

export default function Notifications({ customerId }: { customerId: string }) {
  const [channel, setChannel] = useState("");
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const resource = useResource<History>(`dashboard/notifications?${query({customerId, channel, status, search, page})}`);
  const data = resource.data;
  return <section className="panel"><div className="panel-heading"><div><h2>Notification history</h2><p>Explore delivery states across the full lifecycle.</p></div><span className="subtle-tag">{data ? `${number(data.total)} results` : "Live records"}</span></div>
    <div className="filter-bar"><div className="search-field"><Search size={17}/><input aria-label="Search recipient or notification ID" placeholder="Search recipient or notification ID…" value={search} onChange={e => {setSearch(e.target.value);setPage(1);}}/></div><select aria-label="Filter channel" value={channel} onChange={e => {setChannel(e.target.value);setPage(1);}}><option value="">All channels</option><option value="email">Email</option><option value="sms">SMS</option></select><select aria-label="Filter status" value={status} onChange={e => {setStatus(e.target.value);setPage(1);}}><option value="">All statuses</option>{["pending","queued","processing","processed","provider_accepted","delivered","failed","outcome_unknown","suppressed"].map(s => <option key={s} value={s}>{statusLabel(s)}</option>)}</select></div>
    <ErrorState message={resource.error} retry={resource.refresh}/>{resource.loading ? <Loading/> : data && (data.notifications.length ? <NotificationTable rows={data.notifications}/> : <Empty title="No notifications found" body={search || channel || status ? "Try changing your search, channel or status filters." : "Send a notification to start building your history."}/>)}
    <div className="pagination"><span>{data?.total ? `${number((page - 1) * 15 + 1)}–${number(Math.min(page * 15, data.total))} of ${number(data.total)}` : "0 results"}</span><div><button className="button secondary" disabled={page === 1} onClick={() => setPage(p => p - 1)}><ChevronLeft size={15}/>Previous</button><span>Page {page}</span><button className="button secondary" disabled={!data || page * 15 >= data.total} onClick={() => setPage(p => p + 1)}>Next<ChevronRight size={15}/></button></div></div>
  </section>;
}
