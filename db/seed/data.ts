import type { DropPointHours } from "../schema";

export const CLUSTERS = [
  {
    slug: "central-east",
    name: "Indiranagar – Koramangala",
    // Indiranagar, HAL 2nd stage, Domlur, Koramangala 1–8 blocks, Ejipura, Viveknagar
    pincodes: ["560008", "560038", "560071", "560075", "560034", "560095", "560047", "560029"],
    status: "open" as const,
  },
  {
    slug: "south",
    name: "Jayanagar – JP Nagar",
    pincodes: ["560011", "560041", "560069", "560070", "560078"],
    status: "waitlist" as const,
  },
  {
    slug: "north",
    name: "Malleshwaram – Sadashivanagar",
    pincodes: ["560003", "560055", "560080"],
    status: "waitlist" as const,
  },
];

const CAFE_HOURS: DropPointHours = {
  mon: { open: "08:00", close: "22:00" },
  tue: { open: "08:00", close: "22:00" },
  wed: { open: "08:00", close: "22:00" },
  thu: { open: "08:00", close: "22:00" },
  fri: { open: "08:00", close: "23:00" },
  sat: { open: "08:00", close: "23:00" },
  sun: { open: "09:00", close: "22:00" },
};

const BOOKSHOP_HOURS: DropPointHours = {
  mon: null,
  tue: { open: "10:30", close: "20:30" },
  wed: { open: "10:30", close: "20:30" },
  thu: { open: "10:30", close: "20:30" },
  fri: { open: "10:30", close: "20:30" },
  sat: { open: "10:30", close: "21:00" },
  sun: { open: "11:00", close: "20:00" },
};

export const DROP_POINTS = [
  {
    name: "Third Wave Coffee, 12th Main",
    address: "12th Main Rd, HAL 2nd Stage, Indiranagar, Bengaluru 560008",
    contact: "Manager: Rakesh, +91 98450 00001",
    hours: CAFE_HOURS,
    capacity: 20,
  },
  {
    name: "Bookworm Koramangala",
    address: "80 Feet Rd, 4th Block, Koramangala, Bengaluru 560034",
    contact: "Owner: Krishna, +91 98450 00002",
    hours: BOOKSHOP_HOURS,
    capacity: 30,
  },
];

/** 30 members. Phone numbers are fixed so local test-OTP logins can map onto them. */
export const MEMBERS: Array<{
  displayName: string;
  phone: string; // E.164 without +
  state: "registered" | "active" | "suspended" | "cancelled";
  ageDays: number;
  isAdmin?: boolean;
  upiId?: string;
}> = [
  {
    displayName: "Ananya",
    phone: "919999900001",
    state: "active",
    ageDays: 180,
    isAdmin: true,
    upiId: "ananya@okaxis",
  },
  {
    displayName: "Rohan",
    phone: "919999900002",
    state: "active",
    ageDays: 160,
    upiId: "rohan@ybl",
  },
  {
    displayName: "Meera",
    phone: "919999900003",
    state: "active",
    ageDays: 150,
    upiId: "meera@okicici",
  },
  {
    displayName: "Karthik",
    phone: "919999900004",
    state: "active",
    ageDays: 140,
    upiId: "karthik@paytm",
  },
  {
    displayName: "Divya",
    phone: "919999900005",
    state: "active",
    ageDays: 130,
  },
  {
    displayName: "Arjun",
    phone: "919999900006",
    state: "active",
    ageDays: 120,
    upiId: "arjun@okaxis",
  },
  {
    displayName: "Sneha",
    phone: "919999900007",
    state: "active",
    ageDays: 110,
  },
  {
    displayName: "Vikram",
    phone: "919999900008",
    state: "active",
    ageDays: 100,
    upiId: "vikram@ybl",
  },
  { displayName: "Priya", phone: "919999900009", state: "active", ageDays: 95 },
  {
    displayName: "Aditya",
    phone: "919999900010",
    state: "active",
    ageDays: 90,
    upiId: "aditya@okhdfcbank",
  },
  {
    displayName: "Nandini",
    phone: "919999900011",
    state: "active",
    ageDays: 85,
  },
  {
    displayName: "Siddharth",
    phone: "919999900012",
    state: "active",
    ageDays: 80,
  },
  {
    displayName: "Kavya",
    phone: "919999900013",
    state: "active",
    ageDays: 75,
    upiId: "kavya@okaxis",
  },
  { displayName: "Rahul", phone: "919999900014", state: "active", ageDays: 70 },
  {
    displayName: "Ishita",
    phone: "919999900015",
    state: "active",
    ageDays: 65,
  },
  {
    displayName: "Manish",
    phone: "919999900016",
    state: "registered",
    ageDays: 120,
  },
  {
    displayName: "Pooja",
    phone: "919999900017",
    state: "registered",
    ageDays: 100,
  },
  {
    displayName: "Nikhil",
    phone: "919999900018",
    state: "suspended",
    ageDays: 130,
  },
  { displayName: "Shreya", phone: "919999900019", state: "cancelled", ageDays: 200 },
  { displayName: "Varun", phone: "919999900020", state: "registered", ageDays: 60 },
  { displayName: "Lakshmi", phone: "919999900021", state: "registered", ageDays: 45 },
  { displayName: "Harsha", phone: "919999900022", state: "registered", ageDays: 30 },
  { displayName: "Tanvi", phone: "919999900023", state: "registered", ageDays: 25 },
  { displayName: "Gaurav", phone: "919999900024", state: "registered", ageDays: 20 },
  { displayName: "Ritika", phone: "919999900025", state: "registered", ageDays: 14 },
  { displayName: "Abhishek", phone: "919999900026", state: "registered", ageDays: 10 },
  { displayName: "Neha", phone: "919999900027", state: "registered", ageDays: 6 },
  { displayName: "Suresh", phone: "919999900028", state: "registered", ageDays: 3 },
  { displayName: "Deepa", phone: "919999900029", state: "registered", ageDays: 1 },
  { displayName: "Yash", phone: "919999900030", state: "registered", ageDays: 0 },
];
