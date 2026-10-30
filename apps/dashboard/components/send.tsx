"use client";
import { useRef, useState } from "react";
import { ArrowRight, FlaskConical, LoaderCircle, Mail, MessageSquare, Send, ShieldCheck } from "lucide-react";
import { api } from "../lib/api";
import type { Channel } from "../lib/types";
import { Badge, ErrorState, Notice, Success } from "./ui";

const scenarios = [
  { id: "503", title: "Service unavailable", code: "HTTP 503", description: "A persistent provider outage. Retries back off exponentially, then terminate as failed." },
  { id: "429", title: "Provider rate limit", code: "HTTP 429", description: "A persistent quota rejection. Retries back off exponentially, then terminate as failed." },
  { id: "timeout", title: "Network timeout", code: "TIMEOUT", description: "The delivery outcome becomes unknown. Blind retries stop to prevent duplicate delivery." },
  { id: "400", title: "Permanent rejection", code: "HTTP 400", description: "A non-retryable rejection. Processing stops immediately with a failed status." },
  { id: "success", title: "Successful acceptance", code: "HTTP 202", description: "A clean control request. The simulated provider accepts the notification." },
];

export default function SendNotification({ customerId, simulator = false, onHistory }: { customerId: string; simulator?: boolean; onHistory: () => void }) {
  const [channel, setChannel] = useState<Channel>("email");
  const [recipient, setRecipient] = useState("");
  const [subject, setSubject] = useState("A little hello from Relay");
  const [body, setBody] = useState("Your notification pipeline is ready. This is a test notification from the Relay dashboard.");
  const [mode, setMode] = useState("503");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<{ id: string; status: string; isReplay?: boolean }>();
  const requestRef = useRef<{ signature: string; key: string } | null>(null);
  const simulationRecipient = mode === "success" ? "relay-control@example.com" : `relay-sim-${mode}@example.com`;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError(undefined); setResult(undefined);
    const request = { customerId, channel: simulator ? "email" : channel, recipient: simulator ? simulationRecipient : recipient, payload: (simulator || channel === "email") ? { subject, body } : { body } };
    const signature = JSON.stringify(request);
    if (requestRef.current?.signature !== signature) requestRef.current = { signature, key: crypto.randomUUID() };
    try {
      const response = await api<{id:string; status:string; isReplay?: boolean}>("notifications", { method: "POST", body: signature, headers: { "Idempotency-Key": requestRef.current!.key } });
      setResult(response);
      requestRef.current = null;
    } catch (e) { setError(e instanceof Error ? e.message : "Submission failed."); }
    finally { setBusy(false); }
  }

  return <div className="form-layout"><section className="panel form-panel"><div className="panel-heading"><div><h2>{simulator ? "Create a failure scenario" : "Compose notification"}</h2><p>{simulator ? "Exercise the existing provider simulator through the real queue." : "A test message, sent through your real notification pipeline."}</p></div><span className="subtle-tag">{simulator ? "Simulated provider" : "Test request"}</span></div>
    <form onSubmit={submit} className="form-body">
      {!customerId && <Notice>Select a tenant in the workspace header to submit a request.</Notice>}
      {simulator ? <><div className="scenario-list">{scenarios.map(s => <label key={s.id} className={`scenario ${mode === s.id ? "selected" : ""}`}><input type="radio" name="scenario" value={s.id} checked={mode === s.id} onChange={() => setMode(s.id)} /><div><strong>{s.title}<span className="scenario-code">{s.code}</span></strong><p>{s.description}</p></div></label>)}</div><div className="destination"><span>Simulation recipient</span><code>{simulationRecipient}</code></div></> : <><label className="field-label">Delivery channel</label><div className="channel-selector"><button type="button" className={channel === "email" ? "selected" : ""} onClick={() => {setChannel("email");setRecipient("");}}><Mail size={19}/><span>Email<small>Send a test email</small></span>{channel === "email" && <span className="selected-dot"/>}</button><button type="button" className={channel === "sms" ? "selected" : ""} onClick={() => {setChannel("sms");setRecipient("");}}><MessageSquare size={19}/><span>SMS<small>Send a text message</small></span>{channel === "sms" && <span className="selected-dot"/>}</button></div><label className="field-label" htmlFor="recipient">Recipient {channel === "email" ? "email" : "phone number"}</label><input id="recipient" type={channel === "email" ? "email" : "tel"} required maxLength={255} placeholder={channel === "email" ? "you@example.com" : "+234 800 000 0000"} value={recipient} onChange={e => setRecipient(e.target.value)}/></>}
      {(simulator || channel === "email") && <><label className="field-label" htmlFor="subject">Subject</label><input id="subject" value={subject} onChange={e => setSubject(e.target.value)} required maxLength={998}/></>}
      <label className="field-label" htmlFor="message">Message</label><textarea id="message" rows={5} value={body} onChange={e => setBody(e.target.value)} required maxLength={!simulator && channel === "sms" ? 1600 : 12000}/><div className="field-hint">{!simulator && channel === "sms" ? `${body.length} / 1,600 characters` : "Plain text message body"}</div>
      <ErrorState message={error}/>{result && <Success><strong>{result.status === "suppressed" ? "Notification suppressed" : "Request accepted"}</strong><p><Badge status={result.status}/> <span className="mono">{result.id}</span>{result.isReplay && " · Replayed safely"}</p><button type="button" className="text-button" onClick={onHistory}>Follow in notification history <ArrowRight size={14}/></button></Success>}
      <div className="form-footer"><span><ShieldCheck size={15}/>Idempotency protected</span><button type="submit" className="button primary" disabled={!customerId || busy}>{busy ? <LoaderCircle size={16} className="animate-spin"/> : simulator ? <FlaskConical size={16}/> : <Send size={16}/>} {busy ? "Submitting…" : simulator ? "Run scenario" : "Send notification"}</button></div>
    </form></section><aside className="form-aside"><div className="aside-illustration"><div className="pipeline-node"><Send size={24}/></div><span/><div className="pipeline-node"><Mail size={24}/></div></div><span className="eyebrow">{simulator ? "CONTROLLED FAILURE TESTING" : "BUILT FOR RELIABILITY"}</span><h2>{simulator ? "See resilience in action." : "One request. A reliable journey."}</h2><p>{simulator ? "These scenarios use recipient conventions already supported by Relay. Each scenario creates an email notification; no worker configuration changes are needed." : "Your message is durably saved in PostgreSQL before the dispatcher publishes it to a channel queue."}</p><ol className="journey"><li><span>1</span><div><strong>Durable acceptance</strong><p>Notification and outbox commit together.</p></div></li><li><span>2</span><div><strong>Fair queue processing</strong><p>Tenant limits and preferences apply.</p></div></li><li><span>3</span><div><strong>Provider outcome</strong><p>Workers record acceptance or failure.</p></div></li></ol><Notice>{simulator ? "503 and 429 patterns persist through all 5 attempts (about 30 seconds of backoff). Preference opt-outs can suppress a scenario. Failure injection is scoped to this email address; the SMS send form remains available for normal SMS tests." : "Providers are simulated. Provider acceptance is distinct from confirmed delivery. An opted-out recipient returns a suppressed notification."}</Notice></aside></div>;
}
