import express from "express";
import cors from "cors";
import Stripe from "stripe";
import { google } from "googleapis";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
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

if (!STRIPE_SECRET_KEY) {
  console.warn("Missing STRIPE_SECRET_KEY");
}
if (!GOOGLE_CLIENT_EMAIL || !GOOGLE_PRIVATE_KEY || !GOOGLE_CALENDAR_ID) {
  console.warn("Missing Google Calendar credentials");
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

function buildSlotISO(date, hour, minute = 0) {
  // Uses the server timezone. For production, deploy in the studio timezone or
  // replace with a timezone-aware library such as Luxon.
  const dt = new Date(`${date}T00:00:00`);
  dt.setHours(hour, minute, 0, 0);
  return dt.toISOString();
}

function formatLabel(iso) {
  const dt = new Date(iso);
  return dt.toLocaleTimeString("en-US", {
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
      success_url: `${SITE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_URL}/cancel.html`,
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
              `Stripe Session: ${session.id}`
            ].join("\n"),
            start: { dateTime: slot_start_iso },
            end: { dateTime: slot_end_iso },
            attendees: [{ email: customer_email, displayName: customer_name }]
          }
        });
      }
    } catch (error) {
      console.error("Calendar booking error:", error);
    }
  }

  res.json({ received: true });
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`2K STUDIOS booking app running on port ${PORT}`);
});