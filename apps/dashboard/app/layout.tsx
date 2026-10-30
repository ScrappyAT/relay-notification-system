import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Relay · Notification workspace",
  description: "Local operations console for Relay notification infrastructure.",
  robots: { index: false, follow: false },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
