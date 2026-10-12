import "dotenv/config";
import express from "express";
import cors from "cors";
import Stripe from "stripe";
import { google } from "googleapis";
import { Resend } from "resend";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(express.static("public"));
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SITE_URL = process.env.SITE_URL || "http://localhost:3000";
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL || "";
const GOOGLE_PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || "";
const RESERVATION_DEPOSIT_CENTS = Number(process.env.RESERVATION_DEPOSIT_CENTS || 2500);

// All booking slots are wall-clock times in the studio timezone (Eastern),
// regardless of the server's own timezone (Render runs on UTC).
const STUDIO_TZ = "America/New_York";
// Email address that receives a notification for every completed booking.
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || "2kstudiosnj@gmail.com";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";

if (!STRIPE_SECRET_KEY) {
  console.warn("Missing STRIPE_SECRET_KEY");
}
if (!STRIPE_WEBHOOK_SECRET) {
  console.warn(
    "⚠️  STRIPE_WEBHOOK_SECRET is not set — Stripe webhooks will fail signature verification and NO calendar events or emails will be created."
  );
}
if (!GOOGLE_CLIENT_EMAIL || !GOOGLE_PRIVATE_KEY || !GOOGLE_CALENDAR_ID) {
  console.warn("Missing Google Calendar credentials");
}

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;
if (!resend) {
  console.warn(
    "RESEND_API_KEY is not set — booking notification emails will be skipped."
  );
}

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2025-03-31.basil" });

const auth = new google.auth.JWT({
  email: GOOGLE_CLIENT_EMAIL,
  key: GOOGLE_PRIVATE_KEY,
  scopes: ["https://www.googleapis.com/auth/calendar"]
});
const calendar = google.calendar({ version: "v3", auth });

app.use("/webhook", express.raw({ type: "application/json" }));
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

// Formatter used to read back wall-clock time in the studio timezone.
const easternPartsFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: STUDIO_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false
});

// Interpret `date` (YYYY-MM-DD) + hour/minute as wall-clock time in
// America/New_York and return the corresponding UTC instant as ISO string.
// Works with the Intl API only — no extra dependencies.
function easternWallToISO(date, hour, minute = 0) {
  const [y, m, d] = date.split("-").map(Number);
  const want = Date.UTC(y, m - 1, d, hour, minute, 0);
  // Start by treating the wall time as UTC, then correct by the zone offset.
  // A few refinement passes converge for a fixed-offset zone like Eastern
  // (handles both EST and EDT automatically).
  let guess = want;
  for (let i = 0; i < 3; i++) {
    const parts = {};
    for (const p of easternPartsFormat.formatToParts(new Date(guess))) {
      parts[p.type] = p.value;
    }
    const shown = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour) % 24,
      Number(parts.minute),
      Number(parts.second)
    );
    const diff = want - shown;
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess).toISOString();
}

function buildSlotISO(date, hour, minute = 0) {
  return easternWallToISO(date, hour, minute);
}

function formatLabel(iso) {
  return new Date(iso).toLocaleTimeString("en-US", {
    timeZone: STUDIO_TZ,
    hour: "numeric",
    minute: "2-digit"
  });
}

// Full date + time label in Eastern, e.g. "Monday, October 20, 2026, 10:00 AM".
function formatEasternDateTime(iso) {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: STUDIO_TZ,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

async function getBusyWindows(startISO, endISO) {
  const result = await calendar.freebusy.query({
    requestBody: {
      timeMin: startISO,
      timeMax: endISO,
      items: [{ id: GOOGLE_CALENDAR_ID }]
    }
  });

  return result.data.calendars?.[GOOGLE_CALENDAR_ID]?.busy || [];
}

function overlaps(startISO, endISO, busyWindows) {
  const start = new Date(startISO).getTime();
  const end = new Date(endISO).getTime();

  return busyWindows.some((b) => {
    const busyStart = new Date(b.start).getTime();
    const busyEnd = new Date(b.end).getTime();
    return start < busyEnd && end > busyStart;
  });
}

// Send a booking notification email to the studio owner via Resend.
// Never throws: if RESEND_API_KEY is missing or the send fails, it only logs.
async function sendBookingEmail({
  customer_name,
  customer_email,
  customer_phone,
  slot_start_iso,
  slot_end_iso,
  stripe_session_id
}) {
  if (!resend) {
    console.warn("Skipping booking notification email: RESEND_API_KEY is not set.");
    return;
  }

  const deposit = (RESERVATION_DEPOSIT_CENTS / 100).toFixed(2);
  const when = slot_start_iso
    ? `${formatEasternDateTime(slot_start_iso)} (Eastern)`
    : "unspecified time";

  const text = [
    "New booking received — 2K STUDIOS",
    "",
    `Client: ${customer_name || "—"}`,
    `Email: ${customer_email || "—"}`,
    `Phone: ${customer_phone || "—"}`,
    `When: ${when}`,
    `Deposit paid: $${deposit} USD`,
    `Stripe session: ${stripe_session_id || "—"}`,
    "",
    "The appointment was added to your Google Calendar."
  ].join("\n");

  await resend.emails.send({
    from: "2K Studios <bookings@2kstudios.example>",
    to: NOTIFY_EMAIL,
    subject: `New booking: ${customer_name || "client"} — ${when}`,
    text
  });

  console.log(`Booking notification email sent to ${NOTIFY_EMAIL}`);
}

// Returns free 60-minute slots between 10:00 AM and 6:00 PM.
app.get("/api/availability", async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) {
      return res.status(400).json({ error: "Missing date" });
    }

    const dayStartISO = buildSlotISO(date, 0, 0);
    const dayEndISO = buildSlotISO(date, 23, 59);
    const busy = await getBusyWindows(dayStartISO, dayEndISO);

    const candidateHours = [10, 11, 12, 13, 14, 15, 16, 17];
    const slots = candidateHours
      .map((hour) => {
        const startISO = buildSlotISO(date, hour, 0);
        const endISO = buildSlotISO(date, hour + 1, 0);
        return {
          label: formatLabel(startISO),
          startISO,
          endISO
        };
      })
      .filter((slot) => !overlaps(slot.startISO, slot.endISO, busy));

    res.json({ slots });
  } catch (error) {
    console.error("Availability error:", error);
    res.status(500).json({ error: "Could not load availability" });
  }
});

app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const { name, email, phone, date, slotStartISO, slotEndISO } = req.body;

    if (!name || !email || !phone || !date || !slotStartISO || !slotEndISO) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Double-check that the slot is still free before accepting payment.
    const busy = await getBusyWindows(
      buildSlotISO(date, 0, 0),
      buildSlotISO(date, 23, 59)
    );

    if (overlaps(slotStartISO, slotEndISO, busy)) {
      return res.status(409).json({ error: "That time is no longer available." });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      success_url: `${process.env.SITE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.SITE_URL}/cancel`,
      payment_method_types: ["card"],
      customer_email: email,
      metadata: {
        customer_name: name,
        customer_email: email,
        customer_phone: phone,
        date,
        slot_start_iso: slotStartISO,
        slot_end_iso: slotEndISO
      },
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: "Booking Deposit – 2K STUDIOS",
              description: "Deposit to secure appointment. Applied to total service price."
            },
            unit_amount: RESERVATION_DEPOSIT_CENTS
          },
          quantity: 1
        }
      ]
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error("Checkout session error:", error);
    res.status(500).json({ error: "Could not create checkout session" });
  }
});

app.post("/webhook", async (req, res) => {
  if (!STRIPE_WEBHOOK_SECRET) {
    console.error(
      "Webhook rejected: STRIPE_WEBHOOK_SECRET is not set. Set it in the Render environment variables — no calendar events or emails will be created until then."
    );
    return res
      .status(400)
      .send("Webhook Error: STRIPE_WEBHOOK_SECRET is not configured on the server.");
  }

  let event;

  try {
    const signature = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(req.body, signature, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const {
      customer_name,
      customer_email,
      customer_phone,
      date,
      slot_start_iso,
      slot_end_iso
    } = session.metadata || {};

    try {
      // Final availability check to avoid duplicate bookings.
      const busy = await getBusyWindows(
        buildSlotISO(date, 0, 0),
        buildSlotISO(date, 23, 59)
      );

      if (overlaps(slot_start_iso, slot_end_iso, busy)) {
        console.warn("Slot already busy after payment. Manual follow-up required.");
      } else {
        await calendar.events.insert({
          calendarId: GOOGLE_CALENDAR_ID,
          sendUpdates: "all",
          requestBody: {
            summary: `2K STUDIOS Appointment — ${customer_name}`,
            description: [
              "Reservation deposit paid via Stripe.",
              `Name: ${customer_name}`,
              `Email: ${customer_email}`,
              `Phone: ${customer_phone}`,
              `Stripe Session: ${session.id}`,
              "",
              "WHAT TO EXPECT:",
              "- Your session is reserved. The studio will contact you to plan the details.",
              "- Please arrive 15 minutes early.",
              "- Studio contact: +1 (862) 576-0963"
            ].join("\n"),
            start: { dateTime: slot_start_iso },
            end: { dateTime: slot_end_iso },
            attendees: [
              { email: customer_email, displayName: customer_name },
              { email: NOTIFY_EMAIL, displayName: "2K Studios" }
            ]
          }
        });
      }
    } catch (error) {
      console.error("Calendar booking error:", error);
    }

    // Notify the studio owner by email. Never blocks the webhook response.
    sendBookingEmail({
      customer_name,
      customer_email,
      customer_phone,
      slot_start_iso,
      slot_end_iso,
      stripe_session_id: session.id
    }).catch((error) => {
      console.error("Booking notification email failed:", error.message || error);
    });
  }

  res.json({ received: true });
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
app.get("/success", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "success.html"));
});

app.get("/cancel", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "cancel.html"));
});
app.listen(PORT, () => {
  console.log(`2K STUDIOS booking app running on port ${PORT}`);
});
