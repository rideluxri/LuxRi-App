import React, { useState, useEffect, useRef } from "react";
import { Plane, MapPin, Car, ChevronRight, ChevronLeft, Check, Clock, Users, User, LogOut, History, ArrowRight, MessageSquare, Bell } from "lucide-react";
import { storage } from "./lib/storage";
import { AddressField } from "./components/AddressField";

const OWNER_PHONE = "7045071718";
const BUFFER_MINUTES = 30;
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DEFAULT_HOURS = { days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59", blockedDates: [] };
const CANCEL_CUTOFF_MINUTES = 60;
const LATE_CANCEL_FEE_PCT = 25;
const LOYALTY_EVERY = 5;
const REFERRAL_PCT = 20;
const FIRST_RIDE_PCT = 15;
// One-time code to grant yourself the operator role during sign-up.
// Change this to something only you know, then tell me the new value.
const OPERATOR_SETUP_CODE = "LUXRI-OWNER-SETUP";
const TIP_OPTIONS = [0, 10, 15, 20];

// ---- Theme (inline styles — arbitrary Tailwind color classes aren't reliable here) ----
const C = {
  bg: "#0B0B0F",
  panel: "#131317",
  panelBorder: "#3A3220",
  border: "#2A2A30",
  borderHover: "#3A3A40",
  gold: "#D4AF37",
  goldLight: "#E8C766",
  goldDark: "#B8912F",
  goldWash: "#1A1712",
  ivory: "#ECE7DD",
  muted: "#9C978C",
  mutedDark: "#8A867C",
  faint: "#6B6860",
  faintest: "#5F5C55",
  error: "#B0546A",
  inputBg: "#0E0E12",
};
const goldGradient = `linear-gradient(to bottom, ${C.goldLight}, ${C.goldDark})`;

// ---- Config -------------------------------------------------
const VEHICLES = {
  modely: {
    name: "Model Y",
    tier: "Signature",
    seats: 4,
    color: "#E6C875",
    dark: "#2A2311",
    base: 12,
    perMile: 4,
    airport: 40,
  },
  x7: {
    name: "BMW X7",
    tier: "Reserve",
    seats: 6,
    color: "#B8912F",
    dark: "#221A08",
    base: 17,
    perMile: 5.25,
    airport: 55,
  },
};

const STEPS = ["Route", "Vehicle", "Details", "Confirm"];

const AIRPORT_FLAT_MILE_CAP = 10;

function estimateFare(tripType, vehicleKey, miles) {
  const v = VEHICLES[vehicleKey];
  if (!v) return 0;
  const m = Number(miles) || 0;
  if (tripType === "airport") {
    if (m > AIRPORT_FLAT_MILE_CAP) return v.base + m * v.perMile;
    return v.airport;
  }
  const oneWay = v.base + m * v.perMile;
  return tripType === "round" ? oneWay * 2 - v.base * 0.5 : oneWay;
}

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return String(h);
}

function smsLink(toPhone, body) {
  const digits = (toPhone || "").replace(/[^\d+]/g, "");
  return `sms:${digits}?&body=${encodeURIComponent(body)}`;
}

function normEmail(e) {
  return (e || "").trim().toLowerCase();
}

function normBusiness(b) {
  return (b || "").trim().toLowerCase();
}

// Straight-line distance between two coordinates, adjusted upward to
// roughly approximate real driving distance (roads aren't straight lines).
// Good enough for a fare estimate without needing a separate, billed
// Directions API call for every address pair someone types.
const ROAD_DISTANCE_FACTOR = 1.3;
function estimateDrivingMiles(a, b) {
  if (!a || !b) return null;
  const R = 3958.8; // Earth radius in miles
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const straightLine = 2 * R * Math.asin(Math.sqrt(h));
  return Math.round(straightLine * ROAD_DISTANCE_FACTOR * 10) / 10;
}

function timeToMinutes(t) {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function dayOfWeek(dateStr) {
  if (!dateStr) return null;
  return new Date(dateStr + "T00:00:00").getDay();
}

function withinHours(dateStr, timeStr, hours) {
  if (!dateStr || !timeStr) return true;
  const dow = dayOfWeek(dateStr);
  if (!hours.days.includes(dow)) return false;
  if ((hours.blockedDates || []).includes(dateStr)) return false;
  const t = timeToMinutes(timeStr);
  return t >= timeToMinutes(hours.start) && t <= timeToMinutes(hours.end);
}

function minutesToTime(m) {
  const h = Math.floor(m / 60) % 24;
  const mm = m % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function hoursSummary(hours) {
  const fullDays = hours.days.length === 7;
  const fullTime = hours.start === "00:00" && hours.end === "23:59";
  if (fullDays && fullTime) return "Available 24/7";
  const dayLabel = fullDays ? "every day" : hours.days.map((d) => DAY_NAMES[d]).join(", ");
  return `Available ${dayLabel}, ${hours.start}–${hours.end}`;
}

// Minutes until a booking's pickup, from now. Negative if already past.
function minutesUntilPickup(b) {
  if (!b.date || !b.time) return Infinity;
  const target = new Date(`${b.date}T${b.time}:00`);
  return (target.getTime() - Date.now()) / 60000;
}

function findNearestAvailableTime(bookings, hours, dateStr, desiredTime, excludeCode) {
  const desired = timeToMinutes(desiredTime);
  const offsets = [0];
  for (let step = 15; step <= 240; step += 15) offsets.push(step, -step);
  for (const off of offsets) {
    const candidate = desired + off;
    if (candidate < 0 || candidate > 23 * 60 + 59) continue;
    const candidateTime = minutesToTime(candidate);
    if (!withinHours(dateStr, candidateTime, hours)) continue;
    const conflict = bookings.some((b) => {
      if (excludeCode && b.code === excludeCode) return false;
      if (b.status === "cancelled") return false;
      const legs = [[b.date, b.time]];
      if (b.tripType === "round" && b.returnDate && b.returnTime) legs.push([b.returnDate, b.returnTime]);
      return legs.some(([od, ot]) => od === dateStr && Math.abs(timeToMinutes(ot) - candidate) < BUFFER_MINUTES);
    });
    if (!conflict) return candidateTime;
  }
  return null;
}

// ---- Route progress (signature element) ----------------------
function RouteProgress({ step }) {
  return (
    <div className="w-full px-1">
      <div className="relative h-10">
        <div className="absolute left-0 right-0 top-1/2 h-px" style={{ background: C.border }} />
        <div
          className="absolute left-0 top-1/2 h-px transition-all duration-500"
          style={{ background: C.gold, width: `${(step / (STEPS.length - 1)) * 100}%` }}
        />
        <div className="relative flex justify-between">
          {STEPS.map((label, i) => (
            <div key={label} className="flex flex-col items-center gap-2" style={{ width: 1 }}>
              <div
                className="h-2.5 w-2.5 rounded-full border transition-colors duration-300"
                style={{
                  background: i <= step ? C.gold : C.bg,
                  borderColor: i <= step ? C.gold : C.borderHover,
                }}
              />
              <span
                className="whitespace-nowrap text-[10px] tracking-[0.18em] uppercase"
                style={{ color: i <= step ? C.ivory : C.faint }}
              >
                {label}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Field({ icon, placeholder, value, onChange, type = "text" }) {
  return (
    <div
      className="flex items-center gap-2 border rounded-sm px-3 py-2.5"
      style={{ borderColor: C.border }}
    >
      {icon && <span style={{ color: C.mutedDark }}>{icon}</span>}
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-transparent text-sm focus:outline-none"
        style={{ color: C.ivory }}
      />
    </div>
  );
}

function FeedbackForm({ booking, theme: T, onSubmitted }) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!rating) return;
    setBusy(true);
    try {
      const updated = { ...booking, feedbackRating: rating, feedbackComment: comment, feedbackAt: new Date().toISOString() };
      await storage.set(`booking:${booking.code}`, JSON.stringify(updated));
      onSubmitted(updated);
    } catch {
      // no-op
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border rounded-sm p-3 space-y-2 mt-1" style={{ borderColor: T.gold }}>
      <div className="text-xs" style={{ color: T.mutedDark }}>How was your ride?</div>
      <div className="flex gap-1.5">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            onClick={() => setRating(n)}
            className="h-8 w-8 rounded-sm border text-xs"
            style={
              rating >= n
                ? { borderColor: T.gold, color: T.gold, background: T.goldWash }
                : { borderColor: T.border, color: T.faint }
            }
          >
            {n}
          </button>
        ))}
      </div>
      <textarea
        placeholder="Any comments (optional)"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        rows={2}
        className="w-full rounded-sm px-3 py-2 text-sm focus:outline-none resize-none border"
        style={{ background: T.inputBg, borderColor: T.border, color: T.ivory }}
      />
      <button
        onClick={submit}
        disabled={!rating || busy}
        className="w-full py-2 rounded-sm text-xs tracking-wide disabled:opacity-40"
        style={{ background: `linear-gradient(to bottom, ${T.goldLight}, ${T.goldDark})`, color: T.bg }}
      >
        {busy ? "Submitting…" : "Submit Feedback"}
      </button>
    </div>
  );
}

export default function LuxRiBooking() {
  const [mode, setMode] = useState("welcome"); // welcome | signin | signup | booking | history | lookup | dashboard | driverRides
  const [account, setAccount] = useState(null); // {email, name, phone}
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authName, setAuthName] = useState("");
  const [authPhone, setAuthPhone] = useState("");
  const [authBusiness, setAuthBusiness] = useState("");
  const [authReferralCode, setAuthReferralCode] = useState("");
  const [authStaffCode, setAuthStaffCode] = useState("");
  const [drivers, setDrivers] = useState([]);
  const [driverInvites, setDriverInvites] = useState([]);
  const [inviteGenBusy, setInviteGenBusy] = useState(false);
  const [driverRides, setDriverRides] = useState([]);
  const [inviteContact, setInviteContact] = useState("");
  const [ratingSummary, setRatingSummary] = useState({ avg: 0, count: 0 });
  const [signupFromNudge, setSignupFromNudge] = useState(false);
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [history, setHistory] = useState([]);

  const [dashError, setDashError] = useState("");
  const [dashBookings, setDashBookings] = useState(null);
  const [dashBusy, setDashBusy] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [notifPermission, setNotifPermission] = useState(
    typeof Notification !== "undefined" ? Notification.permission : "unsupported"
  );
  const pendingCountRef = useRef(0);
  const hasLoadedPending = useRef(false);

  const [step, setStep] = useState(0);
  const [tripType, setTripType] = useState("oneway");
  const [pickup, setPickup] = useState("");
  const [dropoff, setDropoff] = useState("");
  const [flight, setFlight] = useState("");
  const [miles, setMiles] = useState("");
  const [pickupCoords, setPickupCoords] = useState(null);
  const [dropoffCoords, setDropoffCoords] = useState(null);
  const [milesAuto, setMilesAuto] = useState(false);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [returnDate, setReturnDate] = useState("");
  const [returnTime, setReturnTime] = useState("");
  const [vehicle, setVehicle] = useState(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [confirmCode, setConfirmCode] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [slotError, setSlotError] = useState("");
  const [suggestedTime, setSuggestedTime] = useState(null);
  const [checkingSlot, setCheckingSlot] = useState(false);
  const [hours, setHours] = useState(DEFAULT_HOURS);
  const [hoursSaving, setHoursSaving] = useState(false);
  const [blockedDateInput, setBlockedDateInput] = useState("");
  const [promos, setPromos] = useState({});
  const [promoBusinessInput, setPromoBusinessInput] = useState("");
  const [promoPctInput, setPromoPctInput] = useState("");
  const [promoSaving, setPromoSaving] = useState(false);
  const [passengers, setPassengers] = useState("");
  const [luggage, setLuggage] = useState("");
  const [tipPct, setTipPct] = useState(15);
  const [tipMode, setTipMode] = useState("pct"); // pct | custom
  const [customTip, setCustomTip] = useState("");
  const [lookupCode, setLookupCode] = useState("");
  const [lookupPhone, setLookupPhone] = useState("");
  const [lookupError, setLookupError] = useState("");
  const [lookupBooking, setLookupBooking] = useState(null);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [rescheduling, setRescheduling] = useState(false);

  const fare = vehicle ? estimateFare(tripType, vehicle, miles) : 0;
  const nonCancelledRides = history.filter((h) => h.status !== "cancelled").length;
  const isLoyaltyRide = !!account && !account.business && !rescheduling && (nonCancelledRides + 1) % LOYALTY_EVERY === 0;
  const loyaltyDiscount = isLoyaltyRide ? Math.round(fare * 0.5 * 100) / 100 : 0;
  const businessPct = account?.business ? promos[normBusiness(account.business)] || 0 : 0;
  const businessDiscount = businessPct > 0 ? Math.round(fare * (businessPct / 100) * 100) / 100 : 0;
  const hasReferralReward = !!account && !rescheduling && (account.referralRewardsAvailable || 0) > 0;
  const referralDiscount = hasReferralReward ? Math.round(fare * (REFERRAL_PCT / 100) * 100) / 100 : 0;
  const isFirstRide = !!account && !rescheduling && nonCancelledRides === 0;
  const firstRideDiscount = isFirstRide ? Math.round(fare * (FIRST_RIDE_PCT / 100) * 100) / 100 : 0;

  // Business rate always wins outright — no stacking with anything else.
  // Otherwise the single best of referral / first-ride / loyalty applies.
  let discountType = null;
  let discountAmount = 0;
  if (businessDiscount > 0) {
    discountType = "business";
    discountAmount = businessDiscount;
  } else {
    const candidates = [
      { type: "referral", amt: referralDiscount },
      { type: "firstRide", amt: firstRideDiscount },
      { type: "loyalty", amt: loyaltyDiscount },
    ].filter((c) => c.amt > 0);
    if (candidates.length) {
      candidates.sort((a, b) => b.amt - a.amt);
      discountType = candidates[0].type;
      discountAmount = candidates[0].amt;
    }
  }
  const effectiveFare = Math.round((fare - discountAmount) * 100) / 100;
  const tipAmount = tipMode === "custom" ? Number(customTip) || 0 : Math.round(fare * (tipPct / 100) * 100) / 100;
  const total = Math.round((effectiveFare + tipAmount) * 100) / 100;

  const checkPending = async () => {
    try {
      const list = await storage.list("booking:");
      let count = 0;
      let ratingSum = 0;
      let ratingCount = 0;
      for (const k of list.keys || []) {
        const res = await storage.get(k);
        if (res) {
          const b = JSON.parse(res.value);
          if (b.status !== "confirmed" && b.status !== "cancelled" && b.status !== "completed") count++;
          if (b.feedbackRating) {
            ratingSum += b.feedbackRating;
            ratingCount += 1;
          }
        }
      }
      if (
        hasLoadedPending.current &&
        count > pendingCountRef.current &&
        typeof Notification !== "undefined" &&
        Notification.permission === "granted"
      ) {
        new Notification("New LuxRi Booking", {
          body: "A customer just booked a ride. Open the Driver Dashboard to confirm.",
        });
      }
      pendingCountRef.current = count;
      hasLoadedPending.current = true;
      setPendingCount(count);
      setRatingSummary({ avg: ratingCount ? ratingSum / ratingCount : 0, count: ratingCount });
    } catch {
      // storage not ready yet
    }
  };

  useEffect(() => {
    checkPending();
    fetchHours();
    fetchPromos();
    const id = setInterval(checkPending, 20000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const estimate = estimateDrivingMiles(pickupCoords, dropoffCoords);
    if (estimate != null) {
      setMiles(String(estimate));
      setMilesAuto(true);
    }
  }, [pickupCoords, dropoffCoords, tripType]);

  const enableNotifications = async () => {
    if (typeof Notification === "undefined") return;
    const perm = await Notification.requestPermission();
    setNotifPermission(perm);
  };

  const loadHistoryFor = async (acct) => {
    try {
      const res = await storage.get(`rides:${acct.email}`);
      setHistory(res ? JSON.parse(res.value) : []);
    } catch {
      setHistory([]);
    }
  };

  const enterBookingAs = async (acct) => {
    resetWizard();
    if (acct) {
      let freshAcct = acct;
      try {
        const res = await storage.get(`account:${acct.email}`);
        if (res) freshAcct = JSON.parse(res.value);
      } catch {
        // fall back to the account we already have
      }
      setAccount(freshAcct);
      setName(freshAcct.name || "");
      setPhone(freshAcct.phone || "");
      setEmail(freshAcct.email || "");
    } else {
      setName("");
      setPhone("");
      setEmail("");
    }
    setMode("booking");
  };

  const handleSignUp = async () => {
    setAuthError("");
    if (!authName || !authEmail || !authPhone || !authPassword) {
      setAuthError("Please fill in all fields.");
      return;
    }
    setAuthBusy(true);
    try {
      const key = `account:${normEmail(authEmail)}`;
      const existing = await storage.get(key).catch(() => null);
      if (existing) {
        setAuthError("An account with that email already exists.");
        setAuthBusy(false);
        return;
      }

      let role = "customer";
      const staffCode = authStaffCode.trim();
      if (staffCode && staffCode.toUpperCase() === OPERATOR_SETUP_CODE.toUpperCase()) {
        role = "operator";
      } else if (staffCode) {
        const inviteKey = `invite:${staffCode.toUpperCase()}`;
        const inviteRes = await storage.get(inviteKey).catch(() => null);
        if (inviteRes) {
          const invite = JSON.parse(inviteRes.value);
          if (invite.status === "pending") {
            role = "driver";
            await storage.set(inviteKey, JSON.stringify({ ...invite, status: "used", usedBy: normEmail(authEmail), usedAt: new Date().toISOString() }));
          } else {
            setAuthError("That invite code has already been used.");
            setAuthBusy(false);
            return;
          }
        } else {
          setAuthError("That staff code isn't valid.");
          setAuthBusy(false);
          return;
        }
      }

      const acct = {
        email: normEmail(authEmail),
        name: authName,
        phone: authPhone,
        business: authBusiness.trim(),
        pass: simpleHash(authPassword),
        role,
        referralCode: "REF-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
        referredBy: authReferralCode.trim() ? authReferralCode.trim().toUpperCase() : "",
        referralConsumed: false,
        referralRewardsAvailable: 0,
      };
      await storage.set(key, JSON.stringify(acct));
      setAccount(acct);

      if (role === "operator") {
        await loadDashboard();
        setMode("dashboard");
      } else if (role === "driver") {
        await loadDriverRides(acct);
        setMode("driverRides");
      } else if (signupFromNudge) {
        try {
          const bres = confirmCode ? await storage.get(`booking:${confirmCode}`).catch(() => null) : null;
          const existingBooking = bres ? JSON.parse(bres.value) : null;
          const newHistory = existingBooking ? [existingBooking] : [];
          await storage.set(`rides:${acct.email}`, JSON.stringify(newHistory));
          setHistory(newHistory);
        } catch {
          setHistory([]);
        }
        setSignupFromNudge(false);
        setMode("history");
      } else {
        setHistory([]);
        enterBookingAs(acct);
      }
    } catch (e) {
      setAuthError("Could not create your account. Please try again.");
    } finally {
      setAuthBusy(false);
    }
  };

  const handleSignIn = async () => {
    setAuthError("");
    if (!authEmail || !authPassword) {
      setAuthError("Enter your email and password.");
      return;
    }
    setAuthBusy(true);
    try {
      const key = `account:${normEmail(authEmail)}`;
      const res = await storage.get(key);
      if (!res) throw new Error("not found");
      const acct = JSON.parse(res.value);
      if (acct.pass !== simpleHash(authPassword)) {
        setAuthError("Incorrect password.");
        setAuthBusy(false);
        return;
      }
      setAccount(acct);
      if (acct.role === "operator") {
        await loadDashboard();
        setMode("dashboard");
      } else if (acct.role === "driver") {
        await loadDriverRides(acct);
        setMode("driverRides");
      } else {
        await loadHistoryFor(acct);
        enterBookingAs(acct);
      }
    } catch (e) {
      setAuthError("No account found with that email.");
    } finally {
      setAuthBusy(false);
    }
  };

  const handleSignOut = () => {
    setAccount(null);
    setHistory([]);
    setDashBookings(null);
    setDrivers([]);
    setDriverInvites([]);
    setDriverRides([]);
    setMode("welcome");
    setName("");
    setPhone("");
    setEmail("");
  };

  const loadDashboard = async () => {
    setDashError("");
    setDashBusy(true);
    try {
      await fetchHours();
      await fetchPromos();
      const list = await storage.list("booking:");
      const items = [];
      for (const k of list.keys || []) {
        const res = await storage.get(k);
        if (res) items.push(JSON.parse(res.value));
      }
      items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      setDashBookings(items);

      const acctList = await storage.list("account:");
      const driverAccts = [];
      for (const k of acctList.keys || []) {
        const res = await storage.get(k);
        if (res) {
          const a = JSON.parse(res.value);
          if (a.role === "driver") driverAccts.push(a);
        }
      }
      setDrivers(driverAccts);

      const inviteList = await storage.list("invite:");
      const invites = [];
      for (const k of inviteList.keys || []) {
        const res = await storage.get(k);
        if (res) invites.push({ code: k.replace("invite:", ""), ...JSON.parse(res.value) });
      }
      invites.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      setDriverInvites(invites);
    } catch (e) {
      setDashError("Could not load dashboard data.");
    } finally {
      setDashBusy(false);
    }
  };

  const loadDriverRides = async (acct) => {
    try {
      const list = await storage.list("booking:");
      const items = [];
      for (const k of list.keys || []) {
        const res = await storage.get(k);
        if (res) {
          const b = JSON.parse(res.value);
          if (b.assignedDriverEmail && normEmail(b.assignedDriverEmail) === normEmail(acct.email)) items.push(b);
        }
      }
      items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      setDriverRides(items);
    } catch {
      setDriverRides([]);
    }
  };

  const generateDriverInvite = async () => {
    setInviteGenBusy(true);
    try {
      const code = "DRV-" + Math.random().toString(36).slice(2, 8).toUpperCase();
      const invite = { status: "pending", createdAt: new Date().toISOString() };
      await storage.set(`invite:${code}`, JSON.stringify(invite));
      setDriverInvites((prev) => [{ code, ...invite }, ...prev]);
    } catch {
      // no-op
    } finally {
      setInviteGenBusy(false);
    }
  };

  const assignDriver = async (booking, driverEmail) => {
    try {
      const updated = { ...booking, assignedDriverEmail: driverEmail || "" };
      await storage.set(`booking:${booking.code}`, JSON.stringify(updated));
      setDashBookings((prev) => prev.map((x) => (x.code === booking.code ? updated : x)));
    } catch {
      // no-op
    }
  };

  const confirmBooking = async (b) => {
    try {
      const updated = { ...b, status: "confirmed" };
      await storage.set(`booking:${b.code}`, JSON.stringify(updated));
      setDashBookings((prev) => prev.map((x) => (x.code === b.code ? updated : x)));
      setDriverRides((prev) => prev.map((x) => (x.code === b.code ? updated : x)));
      checkPending();
      const msg = `Hi ${b.name.split(" ")[0]}, your LuxRi ride on ${b.date} at ${b.time} (${VEHICLES[b.vehicle]?.name}) is confirmed. Confirmation ${b.code}. See you soon!`;
      window.open(smsLink(b.phone, msg), "_self");
    } catch (e) {
      // no-op
    }
  };

  const findAccountByReferralCode = async (code) => {
    if (!code) return null;
    const list = await storage.list("account:");
    for (const k of list.keys || []) {
      const res = await storage.get(k);
      if (res) {
        const a = JSON.parse(res.value);
        if (a.referralCode === code) return { key: k, account: a };
      }
    }
    return null;
  };

  const completeBooking = async (b) => {
    try {
      const updated = { ...b, status: "completed" };
      await storage.set(`booking:${b.code}`, JSON.stringify(updated));
      setDashBookings((prev) => prev.map((x) => (x.code === b.code ? updated : x)));
      setDriverRides((prev) => prev.map((x) => (x.code === b.code ? updated : x)));

      // First completed ride for a referred customer credits the referrer.
      if (b.email) {
        const acctKey = `account:${normEmail(b.email)}`;
        const res = await storage.get(acctKey).catch(() => null);
        if (res) {
          const acct = JSON.parse(res.value);
          if (acct.referredBy && !acct.referralConsumed) {
            const found = await findAccountByReferralCode(acct.referredBy);
            if (found) {
              const updatedReferrer = {
                ...found.account,
                referralRewardsAvailable: (found.account.referralRewardsAvailable || 0) + 1,
              };
              await storage.set(found.key, JSON.stringify(updatedReferrer));
              if (account && normEmail(account.email) === normEmail(found.account.email)) {
                setAccount(updatedReferrer);
              }
            }
            await storage.set(acctKey, JSON.stringify({ ...acct, referralConsumed: true }));
          }
        }
      }
    } catch (e) {
      // no-op
    }
  };

  const fetchHours = async () => {
    try {
      const res = await storage.get("settings:hours");
      if (res) {
        const h = JSON.parse(res.value);
        setHours(h);
        return h;
      }
    } catch {
      // no saved hours yet — use default
    }
    setHours(DEFAULT_HOURS);
    return DEFAULT_HOURS;
  };

  const saveHours = async (next) => {
    setHoursSaving(true);
    try {
      await storage.set("settings:hours", JSON.stringify(next));
      setHours(next);
    } catch {
      // no-op
    } finally {
      setHoursSaving(false);
    }
  };

  const toggleDay = (d) => {
    const days = hours.days.includes(d) ? hours.days.filter((x) => x !== d) : [...hours.days, d].sort();
    saveHours({ ...hours, days });
  };

  const addBlockedDate = () => {
    if (!blockedDateInput) return;
    if ((hours.blockedDates || []).includes(blockedDateInput)) return;
    saveHours({ ...hours, blockedDates: [...(hours.blockedDates || []), blockedDateInput] });
    setBlockedDateInput("");
  };

  const removeBlockedDate = (d) => {
    saveHours({ ...hours, blockedDates: (hours.blockedDates || []).filter((x) => x !== d) });
  };

  const fetchPromos = async () => {
    try {
      const res = await storage.get("settings:promos");
      if (res) {
        const p = JSON.parse(res.value);
        setPromos(p);
        return p;
      }
    } catch {
      // no saved promos yet
    }
    setPromos({});
    return {};
  };

  const savePromo = async () => {
    const biz = normBusiness(promoBusinessInput);
    const pct = Number(promoPctInput);
    if (!biz || !pct || pct <= 0 || pct > 100) return;
    setPromoSaving(true);
    try {
      const next = { ...promos, [biz]: pct };
      await storage.set("settings:promos", JSON.stringify(next));
      setPromos(next);
      setPromoBusinessInput("");
      setPromoPctInput("");
    } catch {
      // no-op
    } finally {
      setPromoSaving(false);
    }
  };

  const removePromo = async (biz) => {
    const next = { ...promos };
    delete next[biz];
    try {
      await storage.set("settings:promos", JSON.stringify(next));
      setPromos(next);
    } catch {
      // no-op
    }
  };

  const fetchAllBookings = async () => {
    const list = await storage.list("booking:");
    const items = [];
    for (const k of list.keys || []) {
      const res = await storage.get(k);
      if (res) items.push(JSON.parse(res.value));
    }
    return items;
  };

  // One driver, two vehicles — only one ride can be on the road at a time,
  // so a pickup or return leg needs at least a 30-minute gap from any existing leg.
  const findSlotConflict = (bookings, excludeCode) => {
    const requested = [[date, time]];
    if (tripType === "round" && returnDate && returnTime) requested.push([returnDate, returnTime]);

    for (const b of bookings) {
      if (excludeCode && b.code === excludeCode) continue;
      if (b.status === "cancelled") continue;
      const occupied = [[b.date, b.time]];
      if (b.tripType === "round" && b.returnDate && b.returnTime) occupied.push([b.returnDate, b.returnTime]);
      for (const [rd, rt] of requested) {
        for (const [od, ot] of occupied) {
          if (rd !== od) continue;
          const diff = Math.abs(timeToMinutes(rt) - timeToMinutes(ot));
          if (diff < BUFFER_MINUTES) return b;
        }
      }
    }
    return null;
  };

  const canNext = () => {
    if (step === 0)
      return (
        pickup &&
        dropoff &&
        date &&
        time &&
        (tripType !== "airport" || flight) &&
        (tripType !== "round" || (returnDate && returnTime))
      );
    if (step === 1) return !!vehicle;
    if (step === 2) return name && phone && email;
    return true;
  };

  const goNext = async () => {
    if (step >= STEPS.length - 1 || !canNext()) return;
    if (step === 0) {
      setSlotError("");
      setSuggestedTime(null);
      setCheckingSlot(true);
      try {
        const currentHours = await fetchHours();
        const bookings = await fetchAllBookings();
        const excludeCode = rescheduling ? confirmCode : null;

        const hoursOk = withinHours(date, time, currentHours);
        const conflict = findSlotConflict(bookings, excludeCode);
        const returnHoursOk = tripType !== "round" || withinHours(returnDate, returnTime, currentHours);

        if (!hoursOk || conflict || !returnHoursOk) {
          const reason = !hoursOk
            ? "That pickup time is outside LuxRi's operating hours."
            : conflict
            ? "That time is too close to another ride (rides need at least 30 minutes apart)."
            : "The return pickup time is outside LuxRi's operating hours.";
          setSlotError(`${reason} Please choose a different time.`);
          const suggestion = findNearestAvailableTime(bookings, currentHours, date, time, excludeCode);
          setSuggestedTime(suggestion);
          setCheckingSlot(false);
          return;
        }
      } catch {
        // if the check fails, fall through and let final submit catch it
      }
      setCheckingSlot(false);
    }
    setStep(step + 1);
  };
  const goBack = () => step > 0 && setStep(step - 1);

  const submitBooking = async () => {
    setSaving(true);
    setError("");
    try {
      const bookings = await fetchAllBookings();
      const conflict = findSlotConflict(bookings, rescheduling ? confirmCode : null);
      if (conflict) {
        setError("Sorry — that time was just booked by someone else. Please go back and pick another time.");
        setSaving(false);
        return;
      }
    } catch {
      // if the re-check fails, proceed — storage.set below is still the source of truth
    }
    const code = rescheduling ? confirmCode : "LR-" + Math.random().toString(36).slice(2, 8).toUpperCase();
    const booking = {
      code,
      status: rescheduling ? "pending" : "pending",
      tripType,
      pickup,
      dropoff,
      flight,
      miles,
      date,
      time,
      returnDate: tripType === "round" ? returnDate : "",
      returnTime: tripType === "round" ? returnTime : "",
      vehicle,
      passengers,
      luggage,
      fare,
      assignedDriverEmail: "",
      business: account?.business || "",
      referredBy: account?.referredBy || "",
      discountType,
      discountAmount,
      effectiveFare,
      tipMode,
      tipPct: tipMode === "pct" ? tipPct : null,
      tipAmount,
      total,
      name,
      phone,
      email,
      notes,
      createdAt: rescheduling ? new Date().toISOString() : new Date().toISOString(),
    };
    try {
      await storage.set(`booking:${code}`, JSON.stringify(booking));
      if (account) {
        const withoutOld = history.filter((h) => h.code !== code);
        const updated = [booking, ...withoutOld];
        await storage.set(`rides:${account.email}`, JSON.stringify(updated));
        setHistory(updated);

        if (discountType === "referral") {
          const nextAccount = { ...account, referralRewardsAvailable: Math.max(0, (account.referralRewardsAvailable || 0) - 1) };
          await storage.set(`account:${account.email}`, JSON.stringify(nextAccount));
          setAccount(nextAccount);
        }
      }
      setConfirmCode(code);
      checkPending();
      setStep(3);
    } catch (e) {
      setError("Could not save the booking. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const resetWizard = () => {
    setStep(0);
    setTripType("oneway");
    setPickup("");
    setDropoff("");
    setFlight("");
    setMiles("");
    setPickupCoords(null);
    setDropoffCoords(null);
    setMilesAuto(false);
    setDate("");
    setTime("");
    setReturnDate("");
    setReturnTime("");
    setVehicle(null);
    setPassengers("");
    setLuggage("");
    setTipPct(15);
    setTipMode("pct");
    setCustomTip("");
    setNotes("");
    setSlotError("");
    setSuggestedTime(null);
    setError("");
    setRescheduling(false);
  };

  const enterReschedule = (b) => {
    if (minutesUntilPickup(b) < CANCEL_CUTOFF_MINUTES) return;
    setTripType(b.tripType);
    setPickup(b.pickup);
    setDropoff(b.dropoff);
    setFlight(b.flight || "");
    setMiles(b.miles || "");
    setPickupCoords(null);
    setDropoffCoords(null);
    setMilesAuto(false);
    setDate(b.date);
    setTime(b.time);
    setReturnDate(b.returnDate || "");
    setReturnTime(b.returnTime || "");
    setVehicle(b.vehicle);
    setPassengers(b.passengers || "");
    setLuggage(b.luggage || "");
    if (b.tipMode === "custom") {
      setTipMode("custom");
      setCustomTip(b.tipAmount != null ? String(b.tipAmount) : "");
    } else {
      setTipMode("pct");
      setTipPct(b.tipPct != null ? b.tipPct : 15);
    }
    setName(b.name);
    setPhone(b.phone);
    setEmail(b.email);
    setNotes(b.notes || "");
    setConfirmCode(b.code);
    setRescheduling(true);
    setSlotError("");
    setError("");
    setStep(0);
    setMode("booking");
  };

  const bookAgain = (b) => {
    setTripType(b.tripType);
    setPickup(b.pickup);
    setDropoff(b.dropoff);
    setFlight(b.flight || "");
    setMiles(b.miles || "");
    setPickupCoords(null);
    setDropoffCoords(null);
    setMilesAuto(false);
    setDate("");
    setTime("");
    setReturnDate("");
    setReturnTime("");
    setVehicle(b.vehicle);
    setPassengers(b.passengers || "");
    setLuggage(b.luggage || "");
    setTipMode("pct");
    setTipPct(15);
    setCustomTip("");
    setName(b.name);
    setPhone(b.phone);
    setEmail(b.email);
    setNotes("");
    setConfirmCode("");
    setRescheduling(false);
    setSlotError("");
    setSuggestedTime(null);
    setError("");
    setStep(0);
    setMode("booking");
  };

  const cancelBooking = async (b, onDone) => {
    const minsLeft = minutesUntilPickup(b);
    if (minsLeft < 0) return; // pickup time has already passed
    const isLate = minsLeft < CANCEL_CUTOFF_MINUTES;
    const fareAmount = Number(b.total ?? b.fare) || 0;
    const fee = isLate ? Math.round(fareAmount * (LATE_CANCEL_FEE_PCT / 100) * 100) / 100 : 0;
    if (isLate) {
      const ok = window.confirm(
        `You're cancelling within ${CANCEL_CUTOFF_MINUTES} minutes of pickup. A cancellation fee of $${fee.toFixed(2)} (${LATE_CANCEL_FEE_PCT}% of the fare) applies. Continue?`
      );
      if (!ok) return;
    }
    try {
      const updated = { ...b, status: "cancelled", lateCancellation: isLate, cancellationFee: fee };
      await storage.set(`booking:${b.code}`, JSON.stringify(updated));
      if (account) {
        const newHistory = history.map((h) => (h.code === b.code ? updated : h));
        await storage.set(`rides:${account.email}`, JSON.stringify(newHistory));
        setHistory(newHistory);
      }
      checkPending();
      if (onDone) onDone(updated);
    } catch {
      // no-op
    }
  };

  const lookupBookingByCode = async () => {
    setLookupError("");
    setLookupBooking(null);
    if (!lookupCode || !lookupPhone) {
      setLookupError("Enter your confirmation code and phone number.");
      return;
    }
    setLookupBusy(true);
    try {
      const res = await storage.get(`booking:${lookupCode.trim().toUpperCase()}`);
      if (!res) throw new Error("not found");
      const b = JSON.parse(res.value);
      const digitsMatch = (b.phone || "").replace(/\D/g, "").slice(-10) === lookupPhone.replace(/\D/g, "").slice(-10);
      if (!digitsMatch) {
        setLookupError("That code and phone number don't match a booking.");
        setLookupBusy(false);
        return;
      }
      setLookupBooking(b);
    } catch {
      setLookupError("No booking found with that code.");
    } finally {
      setLookupBusy(false);
    }
  };

  return (
    <div
      className="min-h-screen w-full flex justify-center py-10 px-4"
      style={{ background: C.bg, color: C.ivory, fontFamily: "Georgia, 'Times New Roman', serif" }}
    >
      <div className="w-full max-w-xl">
        {/* Header */}
        <div className="mb-10 text-center relative">
          {account && (!account.role || account.role === "customer") && mode !== "welcome" && (
            <div className="absolute right-0 top-0 flex items-center gap-3" style={{ fontFamily: "system-ui, sans-serif" }}>
              <button
                onClick={() => { loadHistoryFor(account); setMode("history"); }}
                style={{ color: C.mutedDark }}
                title="My rides"
              >
                <History size={16} />
              </button>
              <button onClick={handleSignOut} style={{ color: C.mutedDark }} title="Sign out">
                <LogOut size={16} />
              </button>
            </div>
          )}
          <div className="text-[11px] tracking-[0.3em] uppercase mb-2" style={{ color: C.muted }}>
            Private Chauffeur
          </div>
          <div className="text-4xl tracking-wide" style={{ letterSpacing: "0.04em" }}>
            Lux<span style={{ color: C.gold }}>Ri</span>
          </div>
          <div className="mt-2 text-sm" style={{ color: C.mutedDark, fontFamily: "system-ui, sans-serif" }}>
            LuxRi Driving Services
          </div>
          <div
            className="mx-auto mt-4 h-px w-16"
            style={{ background: `linear-gradient(to right, transparent, ${C.gold}, transparent)` }}
          />
        </div>

        {mode === "welcome" && (
          <div
            className="rounded-sm border p-6 sm:p-8 space-y-3"
            style={{ borderColor: C.panelBorder, background: C.panel, fontFamily: "system-ui, sans-serif" }}
          >
            {ratingSummary.count > 0 && (
              <div className="text-center text-xs tracking-[0.1em] uppercase" style={{ color: C.gold }}>
                {ratingSummary.avg.toFixed(1)}★ from {ratingSummary.count} ride{ratingSummary.count > 1 ? "s" : ""}
              </div>
            )}
            <div className="text-center text-sm mb-4" style={{ color: C.muted }}>
              Save your details for faster booking, or continue as a guest.
            </div>
            <button
              onClick={() => { setAuthError(""); setMode("signin"); }}
              className="w-full py-3 rounded-sm border text-sm tracking-wide"
              style={{ borderColor: C.gold, color: C.ivory }}
            >
              Sign In
            </button>
            <button
              onClick={() => { setAuthError(""); setMode("signup"); }}
              className="w-full py-3 rounded-sm border text-sm tracking-wide"
              style={{ borderColor: C.border, color: C.ivory }}
            >
              Create Account
            </button>
            <button
              onClick={() => enterBookingAs(null)}
              className="w-full py-3 text-xs tracking-[0.1em] uppercase flex items-center justify-center gap-1"
              style={{ color: C.mutedDark }}
            >
              Continue as Guest <ArrowRight size={12} />
            </button>
            <button
              onClick={() => { setLookupError(""); setLookupBooking(null); setMode("lookup"); }}
              className="w-full text-xs tracking-[0.1em] uppercase flex items-center justify-center gap-1"
              style={{ color: C.mutedDark }}
            >
              Track a Booking
            </button>
          </div>
        )}

        {(mode === "signin" || mode === "signup") && (
          <div
            className="rounded-sm border p-6 sm:p-8 space-y-3"
            style={{ borderColor: C.panelBorder, background: C.panel, fontFamily: "system-ui, sans-serif" }}
          >
            <div className="text-xs tracking-[0.15em] uppercase mb-1 flex items-center gap-2" style={{ color: C.mutedDark }}>
              <User size={14} /> {mode === "signin" ? "Sign in" : "Create your account"}
            </div>
            {mode === "signup" && (
              <>
                <Field placeholder="Full name" value={authName} onChange={setAuthName} />
                <Field placeholder="Phone number" value={authPhone} onChange={setAuthPhone} type="tel" />
                <Field placeholder="Company (optional)" value={authBusiness} onChange={setAuthBusiness} />
                <Field placeholder="Referral code (optional)" value={authReferralCode} onChange={setAuthReferralCode} />
                <Field placeholder="Staff code (operator/driver only)" value={authStaffCode} onChange={setAuthStaffCode} />
              </>
            )}
            <Field placeholder="Email" value={authEmail} onChange={setAuthEmail} type="email" />
            <Field placeholder="Password" value={authPassword} onChange={setAuthPassword} type="password" />
            {authError && <div className="text-sm" style={{ color: C.error }}>{authError}</div>}
            <button
              onClick={mode === "signin" ? handleSignIn : handleSignUp}
              disabled={authBusy}
              className="w-full py-3 rounded-sm text-sm tracking-wide disabled:opacity-40"
              style={{ background: goldGradient, color: C.bg }}
            >
              {authBusy ? "Please wait…" : mode === "signin" ? "Sign In" : "Create Account"}
            </button>
            <button
              onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
              className="w-full text-xs tracking-wide"
              style={{ color: C.mutedDark }}
            >
              {mode === "signin" ? "New here? Create an account" : "Already have an account? Sign in"}
            </button>
            <button onClick={() => { setSignupFromNudge(false); setMode("welcome"); }} className="w-full text-xs tracking-wide" style={{ color: C.faintest }}>
              Back
            </button>
          </div>
        )}

        {mode === "dashboard" && (
          <div
            className="rounded-sm border p-6 sm:p-8 space-y-5"
            style={{ borderColor: C.panelBorder, background: C.panel, fontFamily: "system-ui, sans-serif" }}
          >
            <div className="flex items-center justify-between mb-1">
              <div className="text-xs tracking-[0.15em] uppercase flex items-center gap-2" style={{ color: C.mutedDark }}>
                All Bookings {pendingCount > 0 && <span style={{ color: C.gold }}>({pendingCount} pending)</span>}
              </div>
              <button onClick={handleSignOut} className="text-xs" style={{ color: C.mutedDark }}>
                Sign Out
              </button>
            </div>
            {notifPermission !== "granted" && notifPermission !== "unsupported" && (
              <button
                onClick={enableNotifications}
                className="w-full py-2.5 rounded-sm border text-xs tracking-wide flex items-center justify-center gap-1.5"
                style={{ borderColor: C.gold, color: C.gold }}
              >
                <Bell size={13} /> Enable Booking Notifications
              </button>
            )}

            <div className="border rounded-sm p-3 space-y-2" style={{ borderColor: C.border }}>
              <div className="text-[11px] tracking-[0.15em] uppercase" style={{ color: C.mutedDark }}>
                Availability {hoursSaving && <span style={{ color: C.gold }}>· saving…</span>}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {DAY_NAMES.map((d, i) => (
                  <button
                    key={d}
                    onClick={() => toggleDay(i)}
                    className="px-2.5 py-1.5 rounded-sm text-[11px] border"
                    style={
                      hours.days.includes(i)
                        ? { borderColor: C.gold, color: C.gold, background: C.goldWash }
                        : { borderColor: C.border, color: C.faint }
                    }
                  >
                    {d}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field
                  icon={<Clock size={14} />}
                  placeholder=""
                  value={hours.start}
                  onChange={(v) => saveHours({ ...hours, start: v })}
                  type="time"
                />
                <Field
                  icon={<Clock size={14} />}
                  placeholder=""
                  value={hours.end}
                  onChange={(v) => saveHours({ ...hours, end: v })}
                  type="time"
                />
              </div>
              <div className="flex gap-2 items-center">
                <Field placeholder="" value={blockedDateInput} onChange={setBlockedDateInput} type="date" />
                <button
                  onClick={addBlockedDate}
                  className="px-3 py-2.5 rounded-sm text-xs border shrink-0"
                  style={{ borderColor: C.border, color: C.mutedDark }}
                >
                  Block Date
                </button>
              </div>
              {(hours.blockedDates || []).length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {hours.blockedDates.map((d) => (
                    <span
                      key={d}
                      className="text-[11px] px-2 py-1 rounded-sm border flex items-center gap-1.5"
                      style={{ borderColor: C.border, color: C.mutedDark }}
                    >
                      {d}
                      <button onClick={() => removeBlockedDate(d)} style={{ color: C.error }}>
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="border rounded-sm p-3 space-y-2" style={{ borderColor: C.border }}>
              <div className="text-[11px] tracking-[0.15em] uppercase" style={{ color: C.mutedDark }}>
                Business Promotions {promoSaving && <span style={{ color: C.gold }}>· saving…</span>}
              </div>
              <div className="text-[11px]" style={{ color: C.faint }}>
                Give customers who booked with a company name a percentage off every ride.
              </div>
              <div className="flex gap-2">
                <Field placeholder="Company name" value={promoBusinessInput} onChange={setPromoBusinessInput} />
                <div className="w-20 shrink-0">
                  <Field placeholder="%" value={promoPctInput} onChange={setPromoPctInput} type="number" />
                </div>
                <button
                  onClick={savePromo}
                  className="px-3 py-2.5 rounded-sm text-xs border shrink-0"
                  style={{ borderColor: C.gold, color: C.gold }}
                >
                  Add
                </button>
              </div>
              {Object.keys(promos).length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(promos).map(([biz, pct]) => (
                    <span
                      key={biz}
                      className="text-[11px] px-2 py-1 rounded-sm border flex items-center gap-1.5"
                      style={{ borderColor: C.border, color: C.mutedDark }}
                    >
                      {biz} — {pct}%
                      <button onClick={() => removePromo(biz)} style={{ color: C.error }}>
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="border rounded-sm p-3 space-y-2" style={{ borderColor: C.border }}>
              <div className="text-[11px] tracking-[0.15em] uppercase" style={{ color: C.mutedDark }}>
                Drivers {inviteGenBusy && <span style={{ color: C.gold }}>· generating…</span>}
              </div>
              {drivers.length > 0 && (
                <div className="space-y-1">
                  {drivers.map((d) => (
                    <div key={d.email} className="text-xs" style={{ color: C.ivory }}>
                      {d.name} <span style={{ color: C.mutedDark }}>· {d.phone}</span>
                    </div>
                  ))}
                </div>
              )}
              {drivers.length === 0 && <div className="text-xs" style={{ color: C.mutedDark }}>No drivers added yet.</div>}
              <button
                onClick={generateDriverInvite}
                className="w-full py-2.5 rounded-sm text-xs border"
                style={{ borderColor: C.gold, color: C.gold }}
              >
                Generate Driver Invite Code
              </button>
              {driverInvites.filter((i) => i.status === "pending").length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {driverInvites
                    .filter((i) => i.status === "pending")
                    .map((i) => (
                      <span
                        key={i.code}
                        className="text-[11px] px-2 py-1 rounded-sm border"
                        style={{ borderColor: C.border, color: C.gold }}
                      >
                        {i.code} (unused)
                      </span>
                    ))}
                </div>
              )}
              <div className="text-[11px]" style={{ color: C.faint }}>
                Give a driver this code — they'll enter it as a "staff code" when creating their account.
              </div>
            </div>

            {(!dashBookings || dashBookings.length === 0) && (
              <div className="text-sm" style={{ color: C.mutedDark }}>No bookings yet.</div>
            )}
            {dashBookings &&
              dashBookings.map((b) => (
                <div
                  key={b.code}
                  className="border rounded-sm p-3 text-sm space-y-2"
                  style={{ borderColor: C.border, opacity: b.status === "cancelled" ? 0.5 : 1 }}
                >
                  <div className="flex justify-between items-start">
                    <div>
                      <div style={{ color: C.ivory }}>
                        {b.name} · {VEHICLES[b.vehicle]?.name}
                        {b.business && <span style={{ color: C.gold }}> · {b.business}</span>}
                      </div>
                      <div className="text-xs mt-0.5" style={{ color: C.mutedDark }}>
                        {b.date} · {b.time} · {b.tripType} · ${Number(b.total ?? b.fare).toFixed(0)}
                        {b.tripType === "round" && b.returnDate ? ` · return ${b.returnDate} ${b.returnTime}` : ""}
                      </div>
                      <div className="text-xs" style={{ color: C.mutedDark }}>{b.pickup} → {b.dropoff}</div>
                      <div className="text-xs" style={{ color: C.mutedDark }}>{b.phone}</div>
                      {(b.passengers || b.luggage) && (
                        <div className="text-xs" style={{ color: C.mutedDark }}>
                          {b.passengers && `${b.passengers} pax`}{b.passengers && b.luggage ? " · " : ""}{b.luggage && `${b.luggage} bags`}
                        </div>
                      )}
                      {b.feedbackRating && (
                        <div className="text-xs" style={{ color: C.gold }}>Rated {b.feedbackRating}/5{b.feedbackComment ? ` — "${b.feedbackComment}"` : ""}</div>
                      )}
                      {b.status === "cancelled" && b.lateCancellation && (
                        <div className="text-xs" style={{ color: C.error }}>
                          Late cancellation — ${Number(b.cancellationFee || 0).toFixed(2)} fee applies
                        </div>
                      )}
                    </div>
                    <span
                      className="text-[10px] uppercase tracking-wide px-2 py-1 rounded-sm shrink-0 border"
                      style={
                        b.status === "confirmed" || b.status === "completed"
                          ? { background: "#2A2311", color: C.gold, borderColor: C.gold }
                          : { background: "transparent", color: C.mutedDark, borderColor: C.border }
                      }
                    >
                      {b.status || "pending"}
                    </span>
                  </div>
                  {drivers.length > 0 && b.status !== "cancelled" && (
                    <div className="flex items-center gap-2">
                      <span className="text-[11px]" style={{ color: C.mutedDark }}>Driver:</span>
                      <select
                        value={b.assignedDriverEmail || ""}
                        onChange={(e) => assignDriver(b, e.target.value)}
                        className="flex-1 rounded-sm px-2 py-1.5 text-xs border"
                        style={{ background: C.inputBg, borderColor: C.border, color: C.ivory }}
                      >
                        <option value="">Unassigned (me)</option>
                        {drivers.map((d) => (
                          <option key={d.email} value={d.email}>
                            {d.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  {b.status !== "confirmed" && b.status !== "cancelled" && b.status !== "completed" && (
                    <button
                      onClick={() => confirmBooking(b)}
                      className="w-full py-2 rounded-sm text-xs tracking-wide flex items-center justify-center gap-1.5"
                      style={{ background: goldGradient, color: C.bg }}
                    >
                      <MessageSquare size={12} /> Confirm & Text Customer
                    </button>
                  )}
                  {b.status === "confirmed" && (
                    <button
                      onClick={() => completeBooking(b)}
                      className="w-full py-2 rounded-sm text-xs tracking-wide border"
                      style={{ borderColor: C.gold, color: C.gold }}
                    >
                      Mark Ride Complete
                    </button>
                  )}
                </div>
              ))}
          </div>
        )}

        {mode === "driverRides" && (
          <div
            className="rounded-sm border p-6 sm:p-8 space-y-3"
            style={{ borderColor: C.panelBorder, background: C.panel, fontFamily: "system-ui, sans-serif" }}
          >
            <div className="flex items-center justify-between mb-1">
              <div className="text-xs tracking-[0.15em] uppercase" style={{ color: C.mutedDark }}>
                My Rides {account?.name ? `— ${account.name}` : ""}
              </div>
              <button onClick={handleSignOut} className="text-xs" style={{ color: C.mutedDark }}>
                Sign Out
              </button>
            </div>
            {notifPermission !== "granted" && notifPermission !== "unsupported" && (
              <button
                onClick={enableNotifications}
                className="w-full py-2.5 rounded-sm border text-xs tracking-wide flex items-center justify-center gap-1.5"
                style={{ borderColor: C.gold, color: C.gold }}
              >
                <Bell size={13} /> Enable Ride Notifications
              </button>
            )}
            {driverRides.length === 0 && (
              <div className="text-sm" style={{ color: C.mutedDark }}>No rides assigned to you yet.</div>
            )}
            {driverRides.map((b) => (
              <div
                key={b.code}
                className="border rounded-sm p-3 text-sm space-y-2"
                style={{ borderColor: C.border, opacity: b.status === "cancelled" ? 0.5 : 1 }}
              >
                <div className="flex justify-between items-start">
                  <div>
                    <div style={{ color: C.ivory }}>{b.name} · {VEHICLES[b.vehicle]?.name}</div>
                    <div className="text-xs mt-0.5" style={{ color: C.mutedDark }}>
                      {b.date} · {b.time} · {b.tripType}
                      {b.tripType === "round" && b.returnDate ? ` · return ${b.returnDate} ${b.returnTime}` : ""}
                    </div>
                    <div className="text-xs" style={{ color: C.mutedDark }}>{b.pickup} → {b.dropoff}</div>
                    <div className="text-xs" style={{ color: C.mutedDark }}>{b.phone}</div>
                    {(b.passengers || b.luggage) && (
                      <div className="text-xs" style={{ color: C.mutedDark }}>
                        {b.passengers && `${b.passengers} pax`}{b.passengers && b.luggage ? " · " : ""}{b.luggage && `${b.luggage} bags`}
                      </div>
                    )}
                  </div>
                  <span
                    className="text-[10px] uppercase tracking-wide px-2 py-1 rounded-sm shrink-0 border"
                    style={
                      b.status === "confirmed" || b.status === "completed"
                        ? { background: "#2A2311", color: C.gold, borderColor: C.gold }
                        : { background: "transparent", color: C.mutedDark, borderColor: C.border }
                    }
                  >
                    {b.status || "pending"}
                  </span>
                </div>
                {b.status !== "confirmed" && b.status !== "cancelled" && b.status !== "completed" && (
                  <button
                    onClick={() => confirmBooking(b)}
                    className="w-full py-2 rounded-sm text-xs tracking-wide flex items-center justify-center gap-1.5"
                    style={{ background: goldGradient, color: C.bg }}
                  >
                    <MessageSquare size={12} /> Confirm & Text Customer
                  </button>
                )}
                {b.status === "confirmed" && (
                  <button
                    onClick={() => completeBooking(b)}
                    className="w-full py-2 rounded-sm text-xs tracking-wide border"
                    style={{ borderColor: C.gold, color: C.gold }}
                  >
                    Mark Ride Complete
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {mode === "history" && (
          <div
            className="rounded-sm border p-6 sm:p-8 space-y-3"
            style={{ borderColor: C.panelBorder, background: C.panel, fontFamily: "system-ui, sans-serif" }}
          >
            <div className="text-xs tracking-[0.15em] uppercase mb-1" style={{ color: C.mutedDark }}>My Rides</div>

            {account && !account.business && (
              <div className="text-xs" style={{ color: C.mutedDark }}>
                {nonCancelledRides % LOYALTY_EVERY} of {LOYALTY_EVERY} rides toward your next 50% off ride
              </div>
            )}

            {account && (
              <div className="border rounded-sm p-3 space-y-2" style={{ borderColor: C.gold }}>
                <div className="text-[11px] tracking-[0.15em] uppercase" style={{ color: C.gold }}>Refer & Earn</div>
                <div className="text-[11px]" style={{ color: C.mutedDark }}>
                  Send a friend your code — once they take their first ride, you get {REFERRAL_PCT}% off yours.
                </div>
                <div className="text-xs" style={{ color: C.ivory }}>
                  Your code: <span style={{ color: C.gold }}>{account.referralCode}</span>
                  {(account.referralRewardsAvailable || 0) > 0 && (
                    <span style={{ color: C.gold }}> · {account.referralRewardsAvailable} reward{account.referralRewardsAvailable > 1 ? "s" : ""} ready</span>
                  )}
                </div>
                <div className="flex gap-2">
                  <Field placeholder="Friend's phone number" value={inviteContact} onChange={setInviteContact} type="tel" />
                  <a
                    href={smsLink(
                      inviteContact,
                      `I use LuxRi for private car service and thought you'd like it. Use my code ${account.referralCode} when you create your account for ${FIRST_RIDE_PCT}% off your first ride.`
                    )}
                    className="px-3 py-2.5 rounded-sm text-xs shrink-0"
                    style={{ background: goldGradient, color: C.bg, pointerEvents: inviteContact ? "auto" : "none", opacity: inviteContact ? 1 : 0.4 }}
                  >
                    Send Invite
                  </a>
                </div>
              </div>
            )}

            {history.length === 0 && <div className="text-sm" style={{ color: C.mutedDark }}>No rides booked yet.</div>}
            {history.map((r) => (
              <div
                key={r.code}
                className="border rounded-sm p-3 text-sm space-y-2"
                style={{ borderColor: C.border, opacity: r.status === "cancelled" ? 0.5 : 1 }}
              >
                <div className="flex justify-between items-center" style={{ color: C.ivory }}>
                  <span>{VEHICLES[r.vehicle]?.name}</span>
                  <span
                    className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-sm border"
                    style={
                      r.status === "confirmed" || r.status === "completed"
                        ? { color: C.gold, borderColor: C.gold }
                        : { color: C.mutedDark, borderColor: C.border }
                    }
                  >
                    {r.status || "pending"}
                  </span>
                </div>
                <div className="text-xs" style={{ color: C.mutedDark }}>
                  {r.date} · {r.time} · {r.pickup} → {r.dropoff}
                  {r.tripType === "round" && r.returnDate ? ` · return ${r.returnDate} ${r.returnTime}` : ""}
                </div>
                <div className="text-xs" style={{ color: C.mutedDark }}>Total ${Number(r.total ?? r.fare).toFixed(0)}</div>
                {r.status === "cancelled" && r.lateCancellation && (
                  <div className="text-xs" style={{ color: C.error }}>
                    Late cancellation fee: ${Number(r.cancellationFee || 0).toFixed(2)}
                  </div>
                )}
                <div className="text-[11px] tracking-wide" style={{ color: C.faintest }}>{r.code}</div>
                {r.status !== "cancelled" && r.status !== "completed" && (
                  minutesUntilPickup(r) < CANCEL_CUTOFF_MINUTES ? (
                    <div className="space-y-1.5 pt-1">
                      <div className="text-[11px]" style={{ color: C.faint }}>
                        Rescheduling isn't available within 1 hour of pickup.
                      </div>
                      <div className="text-[11px]" style={{ color: C.error }}>
                        Cancelling now incurs a {LATE_CANCEL_FEE_PCT}% fee.
                      </div>
                      <button
                        onClick={() => cancelBooking(r)}
                        className="w-full py-2 rounded-sm text-xs border"
                        style={{ borderColor: C.error, color: C.error }}
                      >
                        Cancel Ride
                      </button>
                    </div>
                  ) : (
                    <div className="flex gap-2 pt-1">
                      <button
                        onClick={() => enterReschedule(r)}
                        className="flex-1 py-2 rounded-sm text-xs border"
                        style={{ borderColor: C.gold, color: C.gold }}
                      >
                        Reschedule
                      </button>
                      <button
                        onClick={() => cancelBooking(r)}
                        className="flex-1 py-2 rounded-sm text-xs border"
                        style={{ borderColor: C.error, color: C.error }}
                      >
                        Cancel Ride
                      </button>
                    </div>
                  )
                )}
                {r.status === "completed" && !r.feedbackRating && (
                  <FeedbackForm
                    booking={r}
                    theme={C}
                    onSubmitted={(updated) => setHistory((prev) => prev.map((h) => (h.code === r.code ? updated : h)))}
                  />
                )}
                {r.status === "completed" && r.feedbackRating && (
                  <div className="text-xs pt-1" style={{ color: C.gold }}>
                    You rated this ride {r.feedbackRating}/5 — thank you!
                  </div>
                )}
                {(r.status === "completed" || r.status === "cancelled") && (
                  <button
                    onClick={() => bookAgain(r)}
                    className="w-full py-2 rounded-sm text-xs border"
                    style={{ borderColor: C.border, color: C.mutedDark }}
                  >
                    Book Again
                  </button>
                )}
              </div>
            ))}
            <button
              onClick={() => enterBookingAs(account)}
              className="w-full py-3 mt-2 rounded-sm text-sm tracking-wide"
              style={{ background: goldGradient, color: C.bg }}
            >
              Book a New Ride
            </button>
          </div>
        )}

        {mode === "lookup" && (
          <div
            className="rounded-sm border p-6 sm:p-8 space-y-3"
            style={{ borderColor: C.panelBorder, background: C.panel, fontFamily: "system-ui, sans-serif" }}
          >
            <div className="text-xs tracking-[0.15em] uppercase mb-1" style={{ color: C.mutedDark }}>Track a Booking</div>
            <Field placeholder="Confirmation code (e.g. LR-AB12CD)" value={lookupCode} onChange={setLookupCode} />
            <Field placeholder="Phone number used to book" value={lookupPhone} onChange={setLookupPhone} type="tel" />
            {lookupError && <div className="text-sm" style={{ color: C.error }}>{lookupError}</div>}
            <button
              onClick={lookupBookingByCode}
              disabled={lookupBusy}
              className="w-full py-3 rounded-sm text-sm tracking-wide disabled:opacity-40"
              style={{ background: goldGradient, color: C.bg }}
            >
              {lookupBusy ? "Looking up…" : "Find My Ride"}
            </button>

            {lookupBooking && (
              <div
                className="border rounded-sm p-3 text-sm space-y-2 mt-2"
                style={{ borderColor: C.border, opacity: lookupBooking.status === "cancelled" ? 0.5 : 1 }}
              >
                <div className="flex justify-between items-center" style={{ color: C.ivory }}>
                  <span>{VEHICLES[lookupBooking.vehicle]?.name}</span>
                  <span
                    className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-sm border"
                    style={
                      lookupBooking.status === "confirmed" || lookupBooking.status === "completed"
                        ? { color: C.gold, borderColor: C.gold }
                        : { color: C.mutedDark, borderColor: C.border }
                    }
                  >
                    {lookupBooking.status || "pending"}
                  </span>
                </div>
                <div className="text-xs" style={{ color: C.mutedDark }}>
                  {lookupBooking.date} · {lookupBooking.time} · {lookupBooking.pickup} → {lookupBooking.dropoff}
                  {lookupBooking.tripType === "round" && lookupBooking.returnDate
                    ? ` · return ${lookupBooking.returnDate} ${lookupBooking.returnTime}`
                    : ""}
                </div>
                <div className="text-xs" style={{ color: C.mutedDark }}>
                  Total ${Number(lookupBooking.total ?? lookupBooking.fare).toFixed(0)}
                </div>
                {lookupBooking.status !== "cancelled" && lookupBooking.status !== "completed" && (
                  minutesUntilPickup(lookupBooking) < CANCEL_CUTOFF_MINUTES ? (
                    <div className="space-y-1.5 pt-1">
                      <div className="text-[11px]" style={{ color: C.faint }}>
                        Rescheduling isn't available within 1 hour of pickup.
                      </div>
                      <div className="text-[11px]" style={{ color: C.error }}>
                        Cancelling now incurs a {LATE_CANCEL_FEE_PCT}% fee.
                      </div>
                      <button
                        onClick={() => cancelBooking(lookupBooking, setLookupBooking)}
                        className="w-full py-2 rounded-sm text-xs border"
                        style={{ borderColor: C.error, color: C.error }}
                      >
                        Cancel Ride
                      </button>
                    </div>
                  ) : (
                    <div className="flex gap-2 pt-1">
                      <button
                        onClick={() => enterReschedule(lookupBooking)}
                        className="flex-1 py-2 rounded-sm text-xs border"
                        style={{ borderColor: C.gold, color: C.gold }}
                      >
                        Reschedule
                      </button>
                      <button
                        onClick={() => cancelBooking(lookupBooking, setLookupBooking)}
                        className="flex-1 py-2 rounded-sm text-xs border"
                        style={{ borderColor: C.error, color: C.error }}
                      >
                        Cancel Ride
                      </button>
                    </div>
                  )
                )}
                {lookupBooking.status === "completed" && !lookupBooking.feedbackRating && (
                  <FeedbackForm booking={lookupBooking} theme={C} onSubmitted={setLookupBooking} />
                )}
                {lookupBooking.status === "completed" && lookupBooking.feedbackRating && (
                  <div className="text-xs pt-1" style={{ color: C.gold }}>
                    You rated this ride {lookupBooking.feedbackRating}/5 — thank you!
                  </div>
                )}
                {(lookupBooking.status === "completed" || lookupBooking.status === "cancelled") && (
                  <button
                    onClick={() => bookAgain(lookupBooking)}
                    className="w-full py-2 rounded-sm text-xs border"
                    style={{ borderColor: C.border, color: C.mutedDark }}
                  >
                    Book Again
                  </button>
                )}
              </div>
            )}
            <button onClick={() => setMode("welcome")} className="w-full text-xs tracking-wide pt-1" style={{ color: C.faintest }}>
              Back
            </button>
          </div>
        )}

        {mode === "booking" && (
          <>
            <div className="mb-8">
              <RouteProgress step={step} />
            </div>

            <div
              className="rounded-sm border p-6 sm:p-8"
              style={{ borderColor: C.panelBorder, background: C.panel, fontFamily: "system-ui, sans-serif" }}
            >
              {step === 0 && (
                <div className="space-y-6">
                  <div className="text-[11px] tracking-[0.1em] uppercase text-center" style={{ color: C.faint }}>
                    {hoursSummary(hours)}
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { key: "oneway", label: "One-Way" },
                      { key: "round", label: "Round Trip" },
                      { key: "airport", label: "Airport" },
                    ].map((t) => (
                      <button
                        key={t.key}
                        onClick={() => setTripType(t.key)}
                        className="py-3 text-xs tracking-[0.1em] uppercase border rounded-sm transition-colors"
                        style={
                          tripType === t.key
                            ? { borderColor: C.gold, color: C.ivory, background: C.goldWash }
                            : { borderColor: C.border, color: C.mutedDark }
                        }
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>

                  <div className="space-y-3">
                    <AddressField
                      icon={<MapPin size={16} />}
                      placeholder="Pickup address"
                      value={pickup}
                      onChange={setPickup}
                      onPlaceSelected={setPickupCoords}
                      theme={C}
                    />
                    <AddressField
                      icon={<MapPin size={16} />}
                      placeholder="Drop-off address"
                      value={dropoff}
                      onChange={setDropoff}
                      onPlaceSelected={setDropoffCoords}
                      theme={C}
                    />
                    {tripType === "airport" && (
                      <Field icon={<Plane size={16} />} placeholder="Flight number" value={flight} onChange={setFlight} />
                    )}
                    <div className="space-y-1">
                      <Field
                        icon={<Car size={16} />}
                        placeholder="Estimated miles"
                        value={miles}
                        onChange={(v) => {
                          setMiles(v);
                          setMilesAuto(false);
                        }}
                        type="number"
                      />
                      {milesAuto && (
                        <div className="text-[11px]" style={{ color: C.faint }}>
                          Auto-estimated from your addresses — edit if needed.
                        </div>
                      )}
                      {tripType === "airport" && (
                        <div className="text-[11px]" style={{ color: C.faint }}>
                          Flat rate applies up to {AIRPORT_FLAT_MILE_CAP} miles; beyond that, standard per-mile pricing applies.
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <Field icon={<Users size={16} />} placeholder="Passengers" value={passengers} onChange={setPassengers} type="number" />
                    <Field icon={<Car size={16} />} placeholder="Bags" value={luggage} onChange={setLuggage} type="number" />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <Field icon={<Clock size={16} />} placeholder="" value={date} onChange={(v) => { setDate(v); setSlotError(""); setSuggestedTime(null); }} type="date" />
                    <Field icon={<Clock size={16} />} placeholder="" value={time} onChange={(v) => { setTime(v); setSlotError(""); setSuggestedTime(null); }} type="time" />
                  </div>
                  {tripType === "round" && (
                    <div className="space-y-2">
                      <div className="text-[11px] tracking-[0.15em] uppercase" style={{ color: C.mutedDark }}>
                        Return Pickup
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <Field icon={<Clock size={16} />} placeholder="" value={returnDate} onChange={(v) => { setReturnDate(v); setSlotError(""); setSuggestedTime(null); }} type="date" />
                        <Field icon={<Clock size={16} />} placeholder="" value={returnTime} onChange={(v) => { setReturnTime(v); setSlotError(""); setSuggestedTime(null); }} type="time" />
                      </div>
                    </div>
                  )}
                  {slotError && (
                    <div className="text-sm" style={{ color: C.error }}>{slotError}</div>
                  )}
                  {slotError && suggestedTime && (
                    <button
                      onClick={() => { setTime(suggestedTime); setSlotError(""); setSuggestedTime(null); }}
                      className="text-xs tracking-wide px-3 py-2 rounded-sm border"
                      style={{ borderColor: C.gold, color: C.gold }}
                    >
                      Try {suggestedTime} instead
                    </button>
                  )}
                  {slotError && !suggestedTime && (
                    <div className="text-xs" style={{ color: C.faint }}>
                      No nearby openings found — try a different date.
                    </div>
                  )}
                </div>
              )}

              {step === 1 && (
                <div className="space-y-4">
                  <div className="text-xs tracking-[0.15em] uppercase mb-1" style={{ color: C.mutedDark }}>
                    Choose your vehicle
                  </div>
                  {(Number(passengers) > 4 || Number(luggage) > 3) && (
                    <div className="text-xs border rounded-sm p-2.5" style={{ borderColor: C.gold, color: C.gold }}>
                      With your group size, the BMW X7 is the better fit.
                    </div>
                  )}
                  {Object.entries(VEHICLES).map(([key, v]) => {
                    const price = estimateFare(tripType, key, miles);
                    const paxCount = Number(passengers) || 0;
                    const fits = paxCount === 0 || paxCount <= v.seats;
                    return (
                      <button
                        key={key}
                        onClick={() => fits && setVehicle(key)}
                        disabled={!fits}
                        className="w-full text-left rounded-sm border p-4 flex items-center justify-between transition-colors disabled:opacity-40"
                        style={{
                          borderColor: vehicle === key ? v.color : C.border,
                          background: vehicle === key ? v.dark : "transparent",
                        }}
                      >
                        <div className="flex items-center gap-3">
                          <Car size={20} color={vehicle === key ? v.color : C.mutedDark} />
                          <div>
                            <div style={{ color: C.ivory }}>{v.name}</div>
                            <div className="text-[11px] uppercase tracking-[0.12em]" style={{ color: v.color }}>
                              {v.tier}
                            </div>
                            <div className="text-[11px] flex items-center gap-1 mt-1" style={{ color: C.mutedDark }}>
                              <Users size={11} /> Seats {v.seats}
                            </div>
                          </div>
                        </div>
                        <div className="text-right">
                          {fits ? (
                            <div className="text-lg">${price.toFixed(0)}</div>
                          ) : (
                            <div className="text-[11px]" style={{ color: C.error }}>Too small for your group</div>
                          )}
                          {vehicle === key && <Check size={14} color={v.color} className="ml-auto mt-1" />}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}

              {step === 2 && (
                <div className="space-y-3">
                  <div className="text-xs tracking-[0.15em] uppercase mb-1" style={{ color: C.mutedDark }}>
                    Your details
                  </div>
                  <Field placeholder="Full name" value={name} onChange={setName} />
                  <Field placeholder="Phone number" value={phone} onChange={setPhone} type="tel" />
                  <Field placeholder="Email" value={email} onChange={setEmail} type="email" />
                  <textarea
                    placeholder="Notes for your chauffeur (optional)"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    rows={3}
                    className="w-full rounded-sm px-3 py-2 text-sm focus:outline-none resize-none border"
                    style={{ background: C.inputBg, borderColor: C.border, color: C.ivory }}
                  />
                  <div className="text-[11px] tracking-[0.15em] uppercase pt-1" style={{ color: C.mutedDark }}>
                    Add a tip
                  </div>
                  <div className="grid grid-cols-5 gap-2">
                    {TIP_OPTIONS.map((p) => (
                      <button
                        key={p}
                        onClick={() => { setTipMode("pct"); setTipPct(p); }}
                        className="py-2.5 text-xs rounded-sm border"
                        style={
                          tipMode === "pct" && tipPct === p
                            ? { borderColor: C.gold, color: C.ivory, background: C.goldWash }
                            : { borderColor: C.border, color: C.mutedDark }
                        }
                      >
                        {p}%
                      </button>
                    ))}
                    <button
                      onClick={() => setTipMode("custom")}
                      className="py-2.5 text-xs rounded-sm border"
                      style={
                        tipMode === "custom"
                          ? { borderColor: C.gold, color: C.ivory, background: C.goldWash }
                          : { borderColor: C.border, color: C.mutedDark }
                      }
                    >
                      $
                    </button>
                  </div>
                  {tipMode === "custom" && (
                    <Field placeholder="Custom tip amount" value={customTip} onChange={setCustomTip} type="number" />
                  )}
                  {discountType === "loyalty" && (
                    <div className="text-xs border rounded-sm p-2.5" style={{ borderColor: C.gold, color: C.gold }}>
                      Loyalty reward — this is your {LOYALTY_EVERY}th ride, 50% off the fare!
                    </div>
                  )}
                  {discountType === "business" && (
                    <div className="text-xs border rounded-sm p-2.5" style={{ borderColor: C.gold, color: C.gold }}>
                      {account?.business} rate applied — {businessPct}% off the fare.
                    </div>
                  )}
                  {discountType === "referral" && (
                    <div className="text-xs border rounded-sm p-2.5" style={{ borderColor: C.gold, color: C.gold }}>
                      Referral reward applied — {REFERRAL_PCT}% off the fare!
                    </div>
                  )}
                  {discountType === "firstRide" && (
                    <div className="text-xs border rounded-sm p-2.5" style={{ borderColor: C.gold, color: C.gold }}>
                      Welcome to LuxRi — {FIRST_RIDE_PCT}% off your first ride!
                    </div>
                  )}
                  <div className="flex justify-between text-sm pt-1" style={{ color: C.mutedDark }}>
                    <span>
                      Fare ${fare.toFixed(0)}
                      {discountType &&
                        ` − $${discountAmount.toFixed(0)} ${
                          { loyalty: "loyalty", business: "business rate", referral: "referral", firstRide: "welcome" }[discountType]
                        }`}{" "}
                      + tip ${tipAmount.toFixed(0)}
                    </span>
                    <span style={{ color: C.ivory }}>Total ${total.toFixed(0)}</span>
                  </div>
                </div>
              )}

              {step === 3 && (
                <div className="text-center py-6 space-y-4">
                  <div
                    className="mx-auto h-12 w-12 rounded-full border flex items-center justify-center"
                    style={{ borderColor: C.gold }}
                  >
                    <Check size={22} style={{ color: C.gold }} />
                  </div>
                  <div className="text-xl">{rescheduling ? "Ride Rescheduled" : "Ride Requested"}</div>
                  <div className="text-sm" style={{ color: C.muted }}>
                    Confirmation code
                    <div className="tracking-[0.2em] mt-1 text-base" style={{ color: C.ivory }}>{confirmCode}</div>
                  </div>
                  <div className="text-sm max-w-xs mx-auto leading-relaxed" style={{ color: C.mutedDark }}>
                    {name.split(" ")[0] || "You"}, your {VEHICLES[vehicle]?.name} is {rescheduling ? "now" : ""} booked for {date} at {time}
                    {tripType === "round" && returnDate && ` (return ${returnDate} at ${returnTime})`}.
                    Estimated total ${total.toFixed(0)} (incl. ${tipAmount.toFixed(0)} tip). Your chauffeur will follow up to confirm payment.
                  </div>
                  <div className="flex items-center justify-center gap-3 pt-2 flex-wrap">
                    <a
                      href={smsLink(
                        OWNER_PHONE,
                        `New LuxRi booking request from ${name}: ${tripType} on ${date} at ${time}${
                          tripType === "round" && returnDate ? `, return ${returnDate} at ${returnTime}` : ""
                        }, ${VEHICLES[vehicle]?.name}, ${pickup} to ${dropoff}. Ref ${confirmCode}.`
                      )}
                      className="text-xs tracking-[0.1em] uppercase px-4 py-2.5 rounded-sm flex items-center gap-1.5"
                      style={{ color: C.bg, background: goldGradient }}
                    >
                      <MessageSquare size={13} /> Notify My Chauffeur
                    </a>
                    <a
                      href={`mailto:${email}?subject=${encodeURIComponent(`LuxRi Ride Receipt — ${confirmCode}`)}&body=${encodeURIComponent(
                        `Thanks for booking with LuxRi Driving Services.\n\nConfirmation: ${confirmCode}\nVehicle: ${VEHICLES[vehicle]?.name}\nPickup: ${pickup}\nDrop-off: ${dropoff}\nDate/Time: ${date} at ${time}${
                          tripType === "round" && returnDate ? `\nReturn: ${returnDate} at ${returnTime}` : ""
                        }\nFare: $${fare.toFixed(0)}${discountType ? `\nDiscount: −$${discountAmount.toFixed(0)}` : ""}\nTip: $${tipAmount.toFixed(
                          0
                        )}\nTotal: $${total.toFixed(0)}`
                      )}`}
                      className="text-xs tracking-[0.1em] uppercase px-4 py-2.5 rounded-sm border flex items-center gap-1.5"
                      style={{ borderColor: C.border, color: C.mutedDark }}
                    >
                      Email Receipt
                    </a>
                  </div>
                  <div className="flex items-center justify-center gap-4 pt-1">
                    {account && (
                      <button
                        onClick={() => setMode("history")}
                        className="text-xs tracking-[0.1em] uppercase flex items-center gap-1"
                        style={{ color: C.gold }}
                      >
                        View my rides <ArrowRight size={12} />
                      </button>
                    )}
                  </div>
                  {!account && (
                    <div className="border rounded-sm p-3 mt-3 text-left" style={{ borderColor: C.gold }}>
                      <div className="text-xs" style={{ color: C.ivory }}>
                        Save these details for faster booking next time?
                      </div>
                      <div className="text-[11px] mt-1" style={{ color: C.mutedDark }}>
                        Create a free account and this ride will already be in your history.
                      </div>
                      <button
                        onClick={() => {
                          setAuthName(name);
                          setAuthPhone(phone);
                          setAuthEmail(email);
                          setAuthBusiness("");
                          setAuthReferralCode("");
                          setAuthError("");
                          setSignupFromNudge(true);
                          setMode("signup");
                        }}
                        className="w-full mt-2 py-2 rounded-sm text-xs tracking-wide"
                        style={{ background: goldGradient, color: C.bg }}
                      >
                        Create Account
                      </button>
                    </div>
                  )}
                </div>
              )}

              {error && <div className="mt-4 text-sm" style={{ color: C.error }}>{error}</div>}

              {step < 3 && (
                <div className="mt-8 flex items-center justify-between">
                  <button
                    onClick={goBack}
                    disabled={step === 0}
                    className="flex items-center gap-1 text-sm disabled:opacity-0"
                    style={{ color: C.mutedDark }}
                  >
                    <ChevronLeft size={16} /> Back
                  </button>
                  {step === 2 ? (
                    <button
                      onClick={submitBooking}
                      disabled={!canNext() || saving}
                      className="flex items-center gap-1 px-5 py-2.5 rounded-sm text-sm tracking-wide disabled:opacity-40"
                      style={{ background: goldGradient, color: C.bg }}
                    >
                      {saving ? "Saving…" : rescheduling ? "Save New Time" : "Request Ride"}
                    </button>
                  ) : (
                    <button
                      onClick={goNext}
                      disabled={!canNext() || checkingSlot}
                      className="flex items-center gap-1 px-5 py-2.5 rounded-sm text-sm tracking-wide disabled:opacity-40"
                      style={{ background: goldGradient, color: C.bg }}
                    >
                      {checkingSlot ? "Checking…" : (<>Continue <ChevronRight size={16} /></>)}
                    </button>
                  )}
                </div>
              )}

              {step === 1 && vehicle && (
                <div className="mt-4 text-right text-xs" style={{ color: C.faint }}>
                  Estimate only — final fare may vary with route and wait time.
                </div>
              )}
            </div>
          </>
        )}

        <div
          className="mt-6 text-center text-[11px] tracking-[0.1em]"
          style={{ color: C.faintest, fontFamily: "system-ui, sans-serif" }}
        >
          LuxRi Driving Services · One-Way · Round Trip · Airport
        </div>
      </div>
    </div>
  );
}
