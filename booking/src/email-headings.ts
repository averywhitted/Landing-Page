// Generated from tools/render-headings.html (see that file). Maps each fixed
// email heading to its pre-drawn Horizon image in assets/headings/.
// Headings not listed here are sent as styled text instead.

import youreBooked from "../assets/headings/youre-booked.png";
import sessionRescheduled from "../assets/headings/session-rescheduled.png";
import sessionCancelled from "../assets/headings/session-cancelled.png";
import finishYourBooking from "../assets/headings/finish-your-booking.png";
import thatTimeWasTaken from "../assets/headings/that-time-was-taken.png";
import newBooking from "../assets/headings/new-booking.png";
import bookingRescheduled from "../assets/headings/booking-rescheduled.png";
import bookingCancelled from "../assets/headings/booking-cancelled.png";
import autoRefunded from "../assets/headings/auto-refunded.png";
import seeYouSoon from "../assets/headings/see-you-soon.png";
import needsAttention from "../assets/headings/needs-attention.png";
import bundleConfirmed from "../assets/headings/bundle-confirmed.png";
import bundlePurchased from "../assets/headings/bundle-purchased.png";
import sessionsExpiring from "../assets/headings/sessions-expiring.png";
import bundleCancelled from "../assets/headings/bundle-cancelled.png";
import paymentDue from "../assets/headings/payment-due.png";
import paymentReceived from "../assets/headings/payment-received.png";
import bundleUpdated from "../assets/headings/bundle-updated.png";
import refundIssued from "../assets/headings/refund-issued.png";
import aboutYourRequest from "../assets/headings/about-your-request.png";
import refundRequest from "../assets/headings/refund-request.png";
import sessionSkipped from "../assets/headings/session-skipped.png";
import repeatsStopped from "../assets/headings/repeats-stopped.png";

export const HEADING_IMAGES: Record<string, { file: string; w: number; h: number }> = {
  "You're booked": { file: "youre-booked.png", w: 316, h: 23 },
  "Session rescheduled": { file: "session-rescheduled.png", w: 469, h: 23 },
  "Session cancelled": { file: "session-cancelled.png", w: 419, h: 23 },
  "Finish your booking": { file: "finish-your-booking.png", w: 441, h: 23 },
  "That time was taken": { file: "that-time-was-taken.png", w: 451, h: 23 },
  "New booking": { file: "new-booking.png", w: 292, h: 23 },
  "Booking rescheduled": { file: "booking-rescheduled.png", w: 488, h: 23 },
  "Booking cancelled": { file: "booking-cancelled.png", w: 438, h: 23 },
  "Auto-refunded": { file: "auto-refunded.png", w: 340, h: 23 },
  "See you soon": { file: "see-you-soon.png", w: 278, h: 23 },
  "Needs attention": { file: "needs-attention.png", w: 368, h: 23 },
  "Bundle confirmed": { file: "bundle-confirmed.png", w: 416, h: 23 },
  "Bundle purchased": { file: "bundle-purchased.png", w: 419, h: 23 },
  "Sessions expiring": { file: "sessions-expiring.png", w: 391, h: 23 },
  "Bundle cancelled": { file: "bundle-cancelled.png", w: 415, h: 23 },
  "Payment due": { file: "payment-due.png", w: 284, h: 23 },
  "Payment received": { file: "payment-received.png", w: 402, h: 23 },
  "Bundle updated": { file: "bundle-updated.png", w: 359, h: 23 },
  "Refund issued": { file: "refund-issued.png", w: 312, h: 23 },
  "About your request": { file: "about-your-request.png", w: 437, h: 24 },
  "Refund request": { file: "refund-request.png", w: 350, h: 24 },
  "Session skipped": { file: "session-skipped.png", w: 355, h: 23 },
  "Repeats stopped": { file: "repeats-stopped.png", w: 374, h: 23 },
};

// Image bytes by file name, served at /email/h/<file>.
export const HEADING_BYTES: Record<string, ArrayBuffer> = {
  "youre-booked.png": youreBooked,
  "session-rescheduled.png": sessionRescheduled,
  "session-cancelled.png": sessionCancelled,
  "finish-your-booking.png": finishYourBooking,
  "that-time-was-taken.png": thatTimeWasTaken,
  "new-booking.png": newBooking,
  "booking-rescheduled.png": bookingRescheduled,
  "booking-cancelled.png": bookingCancelled,
  "auto-refunded.png": autoRefunded,
  "see-you-soon.png": seeYouSoon,
  "needs-attention.png": needsAttention,
  "bundle-confirmed.png": bundleConfirmed,
  "bundle-purchased.png": bundlePurchased,
  "sessions-expiring.png": sessionsExpiring,
  "bundle-cancelled.png": bundleCancelled,
  "payment-due.png": paymentDue,
  "payment-received.png": paymentReceived,
  "bundle-updated.png": bundleUpdated,
  "refund-issued.png": refundIssued,
  "about-your-request.png": aboutYourRequest,
  "refund-request.png": refundRequest,
  "session-skipped.png": sessionSkipped,
  "repeats-stopped.png": repeatsStopped,
};
