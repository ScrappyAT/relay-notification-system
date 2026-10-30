"use client";
import { ArrowRight, ArrowUpRight, CheckCheck, Clock3, Send, ShieldCheck, XCircle } from "lucide-react";
import { useResource, query } from "../lib/api";
import type { History, Monitoring, Overview as OverviewData } from "../lib/types";
import { ActivityChart, Badge, Empty, ErrorState, Loading, Metric, NotificationTable, number } from "./ui";

export default function Overview({ customerId, days, navigate }: { customerId: string; days: number; navigate: (page: string) => void }) {
  const overview = useResource<OverviewData>(`dashboard/overview?${query({ customerId, days })}`);
  const recent = useResource<History>(`dashboard/notifications?${query({ customerId, limit: 5 })}`);
  const monitoring = useResource<Monitoring>("dashboard/monitoring");
  const data = overview.data;
  const acceptedPercent = data && data.total - data.suppressed > 0 ? ((data.accepted + data.delivered) / (data.total - data.suppressed) * 100).toFixed(1) : null;
  return <div className="page-stack">
    <ErrorState message={overview.error} retry={overview.refresh} />
    {overview.loading ? <div className="metrics-grid">{Array.from({length:4}, (_,i) => <div className="metric-card skeleton" key={i}/>)}</div> : data && <div className="metrics-grid">
      <Metric label="Total notifications" value={number(data.total)} icon={<Send size={18}/>} detail={`Across ${data.days} calendar days · UTC`} />
      <Metric label="Provider acceptance" value={acceptedPercent === null ? "—" : `${acceptedPercent}%`} icon={<CheckCheck size={19}/>} detail={`${number(data.accepted + data.delivered)} accepted or delivered`} />
      <Metric label="In flight" value={number(data.in_flight)} icon={<Clock3 size={18}/>} detail="Pending, queued & processing" tone="blue" />
      <Metric label="Failed notifications" value={number(data.failed)} icon={<XCircle size={18}/>} detail={`${number(data.unknown)} outcomes unknown`} tone="red" />
    </div>}
    <div className="chart-grid"><section className="panel activity-panel"><div className="panel-heading"><div><h2>Notification activity</h2><p>Every request, across your delivery channels.</p></div><span className="subtle-tag">Daily · UTC</span></div>
      <div className="chart-legend"><span><i className="legend-dot green"/>Email</span><span><i className="legend-dot purple"/>SMS</span><span className="legend-total">{data ? `${number(data.total)} requests` : ""}</span></div>
      {overview.loading ? <Loading/> : data ? <ActivityChart data={data}/> : <Empty title="Activity unavailable" body="Connect the Relay API to see live activity."/>}
    </section><section className="panel channel-panel"><div className="panel-heading"><div><h2>Channel breakdown</h2><p>Requests by channel</p></div><ArrowUpRight size={17} className="text-slate-400"/></div>
      {data ? <><div className="donut" style={{background: data.total ? `conic-gradient(#199b76 0 ${data.email / data.total * 100}%, #a7afe1 ${data.email / data.total * 100}% 100%)` : "#e8edeb"}}><div><strong>{number(data.total)}</strong><span>Total requests</span></div></div><div className="channel-breakdown"><div><span><i className="legend-dot green"/>Email</span><strong>{number(data.email)} <small>{data.total ? (data.email / data.total * 100).toFixed(1) : 0}%</small></strong></div><div><span><i className="legend-dot purple"/>SMS</span><strong>{number(data.sms)} <small>{data.total ? (data.sms / data.total * 100).toFixed(1) : 0}%</small></strong></div></div></> : overview.loading ? <Loading/> : <Empty title="Channel data unavailable" body="Reconnect the API to load this breakdown."/>}
    </section></div>
    <section className="panel"><div className="panel-heading"><div><h2>Recent notifications <span className="count-pill">Latest 5</span></h2><p>A live look at your notification pipeline.</p></div><button className="text-button" onClick={() => navigate("notifications")}>View all <ArrowRight size={15}/></button></div><ErrorState message={recent.error} retry={recent.refresh}/>{recent.loading ? <Loading/> : recent.data && <NotificationTable rows={recent.data.notifications} compact/>}</section>
    <div className="bottom-grid"><section className="panel system-panel"><div className="panel-heading"><div><h2><ShieldCheck size={17}/>System status</h2><p>Live dependency checks from the API</p></div><button className="text-button" onClick={() => navigate("monitoring")}>Monitoring <ArrowRight size={14}/></button></div><ErrorState message={monitoring.error} retry={monitoring.refresh}/>{monitoring.data ? <div className="system-services">{[["Relay API",monitoring.data.api],["PostgreSQL",monitoring.data.database],["Redis / queues",monitoring.data.redis]].map(([name,status]) => <div key={name}><span>{name}</span><Badge status={status}/></div>)}</div> : monitoring.loading ? <Loading/> : <Empty title="Health data unavailable" body="Reconnect the API to check its dependencies."/>}</section>
    <section className="quickstart-panel"><div className="quickstart-icon"><Send size={20}/></div><div><span className="eyebrow">FROM REQUEST TO RECIPIENT</span><h2>Put your pipeline to work.</h2><p>Send a test email or SMS and follow its journey.</p><button onClick={() => navigate("send")} className="text-button">Send a notification <ArrowUpRight size={15}/></button></div></section></div>
    <div className="footnote"><span><span className="tiny-dot green"/>Auto-refreshes every 15 seconds</span><span>Provider acceptance does not confirm recipient delivery.</span></div>
  </div>;
}
