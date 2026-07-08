// Public marketing-unsubscribe confirmation page.
//
// The marketing-unsubscribe edge function records the opt-out, then 302-redirects
// the browser here — because the Supabase platform force-serves function HTML as
// text/plain (anti-phishing), so a page returned from the function renders as raw
// source. This SPA route renders a real confirmation. No auth, no data fetch:
// the org name + email arrive as query params (React escapes them, so display-safe).
//   Success: /unsubscribed?org=<slug>&name=<org name>&email=<email>
//   Error:   /unsubscribed?error=1

import { useSearchParams } from "react-router-dom";

export default function Unsubscribed() {
  const [params] = useSearchParams();
  const isError = !!params.get("error");
  const name = (params.get("name") || "").trim();
  const email = (params.get("email") || "").trim();

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#f5f5f7",
        fontFamily: "-apple-system,'Helvetica Neue',Helvetica,Arial,sans-serif",
        padding: 24,
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          maxWidth: 480,
          width: "100%",
          background: "#fff",
          border: "1px solid #e5e7eb",
          borderRadius: 16,
          padding: "40px 32px",
          textAlign: "center",
          boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
        }}
      >
        {isError ? (
          <>
            <h1 style={{ fontSize: 22, margin: "0 0 12px", color: "#1f2937" }}>
              This link didn&apos;t work
            </h1>
            <p style={{ fontSize: 16, margin: 0, color: "#6b7280", lineHeight: 1.55 }}>
              This unsubscribe link is invalid or has expired. To stop receiving
              emails, just reply to any message from {name || "us"} and we&apos;ll
              take care of it.
            </p>
          </>
        ) : (
          <>
            <h1 style={{ fontSize: 22, margin: "0 0 12px", color: "#1f2937" }}>
              You&apos;re unsubscribed.
            </h1>
            <p style={{ fontSize: 16, margin: "0 0 8px", color: "#6b7280", lineHeight: 1.55 }}>
              {name ? `${name} won't` : "We won't"} send any more marketing emails
              {email ? (
                <>
                  {" "}to{" "}
                  <span style={{ color: "#674EE8", fontWeight: 600, wordBreak: "break-all" }}>
                    {email}
                  </span>
                </>
              ) : null}
              .
            </p>
            <p style={{ fontSize: 14, margin: "12px 0 0", color: "#9ca3af", lineHeight: 1.55 }}>
              Signed up by mistake or changed your mind? Just reply to any past
              email and we&apos;ll add you back.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
