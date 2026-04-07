# 2K STUDIOS — Professional Booking Starter

This package adds the professional flow you asked for:

- real availability from Google Calendar
- automatic blocking of booked times
- Stripe Checkout for the $25 deposit
- automatic Google Calendar event creation after successful payment
- automatic email invitation/confirmation from Google Calendar

## Files

- `server.js` — backend for availability, Stripe Checkout, and webhook handling
- `public/index.html` — booking UI
- `public/success.html` — post-payment success page
- `public/cancel.html` — canceled payment page
- `.env.example` — environment variables you need

## Setup

1. Create a Stripe secret key and webhook signing secret.
2. Create a Google Cloud service account.
3. Enable the Google Calendar API.
4. Share your booking calendar with the service account email and give it permission to make changes.
5. Copy `.env.example` to `.env` and fill in your real values.
6. Install dependencies:
   npm install express cors stripe googleapis dotenv
7. Run:
   node server.js

## Stripe webhook

Create a webhook endpoint pointing to:

`https://your-domain.com/webhook`

Listen for:
- `checkout.session.completed`

## Notes

- The app checks availability before checkout and again inside the webhook.
- The example uses one-hour slots from 10:00 AM to 6:00 PM.
- The example uses Google Calendar attendee emails so the client can get the calendar invitation automatically.
- For production, set the server timezone correctly or replace the date logic with a timezone-aware library.

## Next recommended improvements

- add buffer time between appointments
- support different session lengths
- save bookings to a database
- send branded email confirmations in addition to the Google Calendar invite