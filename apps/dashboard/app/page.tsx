"use client";
import { useEffect, useState } from "react";
import { Activity, ArrowUpRight, Bell, BookOpen, ChevronsUpDown, CircleHelp, Command, FlaskConical, LayoutDashboard, Menu, Radio, RefreshCw, Send, Settings2, Shield, X } from "lucide-react";
import Overview from "../components/overview";
import Notifications from "../components/notifications";
import SendNotification from "../components/send";
import Preferences from "../components/preferences";
import Monitoring from "../components/monitoring";
import { useResource } from "../lib/api";
import type { Customer } from "../lib/types";
import { ErrorState } from "../components/ui";

const navigation = [
  {id:"overview",label:"Overview",icon:LayoutDashboard},
  {id:"send",label:"Send notification",icon:Send},
  {id:"notifications",label:"Notifications",icon:Bell},
  {id:"preferences",label:"Preferences",icon:Settings2},
  {id:"monitoring",label:"Monitoring",icon:Activity},
  {id:"simulator",label:"Failure simulator",icon:FlaskConical},
];
const descriptions: Record<string,string> = {
  overview:"Your notification infrastructure, at a glance.",send:"A simple way to test your delivery pipeline.",
  notifications:"Every notification. Every step of the journey.",preferences:"The right message, on the right channel.",
  monitoring:"Keep a pulse on your notification infrastructure.",simulator:"Test the unexpected. Build confidence in recovery.",
};

export default function Dashboard() {
  const [page,setPage] = useState("overview");
  const [customerId,setCustomerId] = useState("");
  const [days,setDays] = useState(7);
  const [mobile,setMobile] = useState(false);
  const [revision,setRevision] = useState(0);
  const [help,setHelp] = useState(false);
  const tenants = useResource<{customers:Customer[]}>("dashboard/customers", 60000);
  const title = navigation.find(n => n.id === page)?.label ?? "Overview";
  useEffect(() => {
    const fromHash = window.location.hash.slice(1);
    if (navigation.some(n => n.id === fromHash)) setPage(fromHash);
    const listener = () => { const hash = window.location.hash.slice(1); if(navigation.some(n => n.id === hash)) setPage(hash); };
    window.addEventListener("hashchange",listener);
    return () => window.removeEventListener("hashchange",listener);
  },[]);
  function navigate(value:string) {setPage(value);setMobile(false);setHelp(false);window.location.hash = value;}
  const requiresTenant = ["send","preferences","simulator"].includes(page);
  return <div className="dashboard"><a className="skip-link" href="#main">Skip to content</a>{mobile && <button className="mobile-scrim" onClick={() => setMobile(false)} aria-label="Close navigation"/>}<aside className={`sidebar ${mobile ? "open" : ""}`}><a className="brand" href="#overview" onClick={() => navigate("overview")}><span className="brand-mark"><Radio size={23}/></span>relay<span className="brand-dot">.</span></a><div className="workspace-card"><span className="workspace-avatar">R</span><div><strong>Relay workspace</strong><span>Local development</span></div><ChevronsUpDown size={15}/></div><div className="nav-label">WORKSPACE</div><nav aria-label="Main navigation">{navigation.map(n => <button key={n.id} className={`nav-item ${page === n.id ? "active" : ""}`} aria-current={page === n.id ? "page" : undefined} onClick={() => navigate(n.id)}><n.icon size={18}/><span>{n.label}</span>{page === n.id && <span className="nav-active-dot"/>}</button>)}</nav><div className="sidebar-bottom"><div className="local-card"><span className="local-card-icon"><Shield size={19}/></span><strong>Your local playground</strong><p>Explore, send, and simulate.<br/>Built for your localhost.</p><span><span className="tiny-dot green"/>Development environment</span></div><button className="nav-item" onClick={() => setHelp(true)}><BookOpen size={18}/>Quick start guide<ArrowUpRight size={14}/></button><div className="sidebar-profile"><span className="profile-avatar">D</span><div><strong>Developer</strong><span>Local administrator</span></div><span className="profile-status"/></div></div></aside>
    <div className="main-shell"><header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setMobile(true)}><Menu size={20}/></button><span>Workspace</span><span className="breadcrumb-slash">/</span><strong>{title}</strong></div><div className="topbar-right"><span className="environment-badge"><span className="tiny-dot green"/>Local environment</span><span className="topbar-divider"/><button className="icon-button" title="Local demo information" aria-label="Local demo information" onClick={() => setHelp(v => !v)}><CircleHelp size={19}/></button><span className="top-avatar">D</span></div></header>
    <main id="main"><div className="page-title"><div><div className="eyebrow">NOTIFICATION WORKSPACE</div><h1>{title === "Overview" ? "Overview" : title}</h1><p>{descriptions[page]}</p></div><div className="page-actions"><button className="button secondary icon-refresh" title="Refresh live data" aria-label="Refresh live data" onClick={() => {setRevision(v => v+1);tenants.refresh();}}><RefreshCw size={16}/></button>{page === "overview" && <select aria-label="Overview time range" value={days} onChange={e => setDays(Number(e.target.value))}><option value={1}>Today</option><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option></select>}{page !== "send" && <button className="button primary" onClick={() => navigate("send")}><Send size={15}/>Send notification</button>}</div></div>
      <div className="workspace-toolbar"><div className="tenant-selector"><span className="tenant-icon"><Command size={14}/></span><label htmlFor="tenant">Tenant</label><select id="tenant" value={customerId} onChange={e => setCustomerId(e.target.value)} disabled={tenants.loading}><option value="">{tenants.loading ? "Loading tenants…" : requiresTenant ? "Select a tenant" : "All tenants"}</option>{tenants.data?.customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div><span className="live-label"><span className="tiny-dot green"/>Live backend data</span></div>
      <ErrorState message={tenants.error} retry={tenants.refresh}/>{tenants.data?.customers.length === 0 && <div className="notice">No tenants found. Create a local demo customer using the setup instructions in DASHBOARD.md.</div>}
      <div key={`${customerId}-${revision}`} className="content-enter">{page === "overview" ? <Overview customerId={customerId} days={days} navigate={navigate}/> : page === "notifications" ? <Notifications customerId={customerId}/> : page === "send" || page === "simulator" ? <SendNotification key={page} customerId={customerId} simulator={page === "simulator"} onHistory={() => navigate("notifications")}/> : page === "preferences" ? <Preferences customerId={customerId}/> : <Monitoring/>}</div>
    </main><footer className="app-footer"><span>Relay <span>·</span> Reliable by design.</span><span>Localhost demo <span>·</span> Tenant authentication is not enabled</span></footer></div>
    {help && <div className="modal-backdrop" onClick={() => setHelp(false)}><section className="help-modal" role="dialog" aria-modal="true" aria-labelledby="help-title" onClick={e => e.stopPropagation()} onKeyDown={e => {
      if (e.key === "Escape") setHelp(false);
      if (e.key === "Tab") {
        const buttons = e.currentTarget.querySelectorAll<HTMLButtonElement>("button");
        if (e.shiftKey && document.activeElement === buttons[0]) { e.preventDefault(); buttons[buttons.length-1]?.focus(); }
        else if (!e.shiftKey && document.activeElement === buttons[buttons.length-1]) { e.preventDefault(); buttons[0]?.focus(); }
      }
    }}><button autoFocus className="icon-button modal-close" aria-label="Close help" onClick={() => setHelp(false)}><X size={20}/></button><span className="brand-mark"><Radio size={25}/></span><h2 id="help-title">Your local Relay workspace</h2><p>Start the API with <code>DASHBOARD_ENABLED=true</code>, then run the dispatcher, workers, and dashboard in separate terminals.</p><p>Select an existing tenant, send a test notification, and follow its status in Notifications. Use Preferences for channel opt-outs and Failure simulator for controlled email failures.</p><p>Full setup, commands, and troubleshooting are in <code>DASHBOARD.md</code> at the repository root.</p><div className="notice">This unauthenticated demonstration is restricted to localhost. Do not expose these services through public tunnels or reverse proxies.</div><button className="button primary" onClick={() => setHelp(false)}>Got it<ArrowUpRight size={15}/></button></section></div>}
  </div>;
}
