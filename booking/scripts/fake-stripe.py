#!/usr/bin/env python3
"""A stand-in for Stripe, for testing the booking flow on this Mac only.

It never contacts Stripe. It answers the few API calls the booking service
makes, shows a pretend checkout page, and sends signed webhook notifications
back to the local booking service, exactly like Stripe would.

  python3 scripts/fake-stripe.py            (listens on http://localhost:8799)

Env: WEBHOOK_URL (default http://localhost:8787/api/stripe/webhook)
     WEBHOOK_SECRET (default whsec_localtest; must match the worker's STRIPE_WEBHOOK_SECRET)
"""
import hashlib, hmac, html, itertools, json, os, time, urllib.parse, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "8799"))
WEBHOOK_URL = os.environ.get("WEBHOOK_URL", "http://localhost:8787/api/stripe/webhook")
SECRET = os.environ.get("WEBHOOK_SECRET", "whsec_localtest")
sessions, refunds, counter = {}, [], itertools.count(1)


def parse_form(body):
    """Turn a[b][c]=v form fields back into nested dicts."""
    out = {}
    for key, value in urllib.parse.parse_qsl(body, keep_blank_values=True):
        parts = key.replace("]", "").split("[")
        node = out
        for p in parts[:-1]:
            node = node.setdefault(p, {})
        node[parts[-1]] = value
    return out


def send_webhook(event_type, obj):
    event = {"id": f"evt_fake_{next(counter)}", "type": event_type, "data": {"object": obj}}
    payload = json.dumps(event)
    t = str(int(time.time()))
    sig = hmac.new(SECRET.encode(), f"{t}.{payload}".encode(), hashlib.sha256).hexdigest()
    req = urllib.request.Request(WEBHOOK_URL, data=payload.encode(), method="POST",
                                 headers={"Content-Type": "application/json", "Stripe-Signature": f"t={t},v1={sig}"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else (json.dumps(body) if ctype == "application/json" else body).encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        print("[fake stripe]", fmt % args, flush=True)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path.startswith("/v1/checkout/sessions/"):
            s = sessions.get(path.rsplit("/", 1)[1])
            return self.reply(200, s) if s else self.reply(404, {"error": {"message": "No such session"}})
        if path.startswith("/pay/"):
            s = sessions.get(path.split("/")[2])
            if not s:
                return self.reply(404, "No such checkout", "text/plain")
            item = s["_line"]
            page = f"""<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<title>Fake Stripe Checkout</title>
<body style="font-family:-apple-system,Helvetica,sans-serif;background:#f6f9fc;margin:0;padding:40px 16px">
<div style="max-width:420px;margin:auto;background:#fff;border-radius:12px;padding:28px;box-shadow:0 8px 30px rgba(0,0,0,.08)">
<p style="margin:0 0 6px;color:#697386;font-size:13px">TEST MODE (fake Stripe on this Mac)</p>
<h1 style="margin:0 0 4px;font-size:20px">{html.escape(item['name'])}</h1>
<p style="margin:0 0 18px;color:#697386">{html.escape(item.get('description',''))}</p>
<p style="font-size:28px;font-weight:700;margin:0 0 20px">${int(s['amount_total'])/100:.2f}</p>
<form method=post action="/pay/{s['id']}/complete"><button style="width:100%;padding:14px;border:0;border-radius:8px;background:#635bff;color:#fff;font-size:16px;font-weight:600">Pay (fake)</button></form>
<p style="margin:14px 0 0;text-align:center"><a href="{html.escape(s['cancel_url'])}" style="color:#697386">Back</a></p>
</div></body>"""
            return self.reply(200, page, "text/html")
        self.reply(404, {"error": {"message": "not found"}})

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode()
        if path == "/v1/checkout/sessions":
            f = parse_form(body)
            sid = f"cs_test_fake{next(counter)}"
            li = f["line_items"]["0"]
            host = self.headers.get("Host", f"localhost:{PORT}")
            sessions[sid] = {
                "id": sid, "object": "checkout.session", "status": "open", "payment_status": "unpaid",
                "url": f"http://{host}/pay/{sid}", "amount_total": int(li["price_data"]["unit_amount"]),
                "customer_email": f.get("customer_email"), "metadata": f.get("metadata", {}),
                "payment_intent": None, "expires_at": int(f["expires_at"]),
                "success_url": f["success_url"], "cancel_url": f["cancel_url"],
                "_line": li["price_data"]["product_data"],
            }
            return self.reply(200, sessions[sid])
        if path.startswith("/v1/checkout/sessions/") and path.endswith("/expire"):
            s = sessions.get(path.split("/")[4])
            if not s:
                return self.reply(404, {"error": {"message": "No such session"}})
            if s["status"] != "open":
                return self.reply(400, {"error": {"message": f"Session is {s['status']}", "code": "checkout_session_not_open"}})
            s["status"] = "expired"
            return self.reply(200, s)
        if path == "/v1/refunds":
            f = parse_form(body)
            refunds.append(f)
            print(f"[fake stripe] REFUND for {f.get('payment_intent')}", flush=True)
            return self.reply(200, {"id": f"re_fake{next(counter)}", "status": "succeeded"})
        # Test controls
        if path.startswith("/pay/") and path.endswith("/complete"):
            s = sessions.get(path.split("/")[2])
            if not s or s["status"] != "open":
                return self.reply(400, "Checkout is not open", "text/plain")
            s.update(status="complete", payment_status="paid", payment_intent=f"pi_fake{next(counter)}")
            code = send_webhook("checkout.session.completed", s)
            print(f"[fake stripe] checkout.session.completed -> worker replied {code}", flush=True)
            self.send_response(303)
            self.send_header("Location", s["success_url"].replace("{CHECKOUT_SESSION_ID}", s["id"]))
            self.end_headers()
            return
        if path.startswith("/test/expire/"):
            s = sessions.get(path.rsplit("/", 1)[1])
            if not s:
                return self.reply(404, {"error": "no session"})
            s["status"] = "expired"
            return self.reply(200, {"webhook_status": send_webhook("checkout.session.expired", s)})
        if path.startswith("/test/pay-late/"):
            # Mark paid (as if paid at the last second) and send the webhook.
            s = sessions.get(path.rsplit("/", 1)[1])
            s.update(status="complete", payment_status="paid", payment_intent=f"pi_fake{next(counter)}")
            return self.reply(200, {"webhook_status": send_webhook("checkout.session.completed", s)})
        if path == "/test/state":
            return self.reply(200, {"sessions": sessions, "refunds": refunds})
        self.reply(404, {"error": {"message": "not found"}})


if __name__ == "__main__":
    print(f"[fake stripe] listening on http://localhost:{PORT}, webhooks -> {WEBHOOK_URL}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
