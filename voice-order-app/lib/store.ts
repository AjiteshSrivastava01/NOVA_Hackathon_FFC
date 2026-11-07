import type { Order, OrderItem } from "./types";

// Order storage.
//   Local dev (default):  in memory, lost on restart.
//   Firebase (nova-ffc):  Firestore collection "voice_orders". Locally (free Spark plan),
//                         put these in .env.local:
//                           USE_FIRESTORE=true
//                           GOOGLE_APPLICATION_CREDENTIALS=../functions/firebase-key.local.json
//                         Also used automatically on Firebase App Hosting (Blaze plan).

const COLLECTION = "voice_orders";
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "nova-ffc";
const useFirestore =
  process.env.USE_FIRESTORE === "true" ||
  (process.env.USE_FIRESTORE !== "false" && !!process.env.FIREBASE_CONFIG); // set by App Hosting

// ---------- Firestore ----------
type Db = import("firebase-admin/firestore").Firestore;
let dbPromise: Promise<Db> | null = null;
function db(): Promise<Db> {
  dbPromise ??= (async () => {
    const { getApps, initializeApp } = await import("firebase-admin/app");
    const { getFirestore } = await import("firebase-admin/firestore");
    const app = getApps()[0] ?? initializeApp({ projectId: PROJECT_ID });
    return getFirestore(app);
  })();
  return dbPromise;
}

// ---------- memory ----------
const g = globalThis as unknown as { __orders?: Order[] };
const memory: Order[] = (g.__orders ??= []);

const byCreated = (a: Order, b: Order) => a.createdAt - b.createdAt;

export async function addOrder(table: number, items: OrderItem[], transcript: string): Promise<Order> {
  const order: Order = {
    id: crypto.randomUUID(),
    table,
    // Firestore rejects undefined fields, so drop empty notes.
    items: items.map((i) => (i.notes ? i : { name: i.name, quantity: i.quantity })),
    transcript,
    createdAt: Date.now(),
    status: "open",
  };
  if (useFirestore) await (await db()).collection(COLLECTION).doc(order.id).set(order);
  else memory.push(order);
  return order;
}

export async function listOpen(): Promise<Order[]> {
  if (!useFirestore) return memory.filter((o) => o.status === "open");
  // Equality filter only (no composite index needed); sort here.
  const snap = await (await db()).collection(COLLECTION).where("status", "==", "open").get();
  return snap.docs.map((d) => d.data() as Order).sort(byCreated);
}

export async function getOpenForTable(table: number): Promise<Order[]> {
  if (!useFirestore) return memory.filter((o) => o.status === "open" && o.table === table);
  const snap = await (await db()).collection(COLLECTION)
    .where("status", "==", "open").where("table", "==", table).get();
  return snap.docs.map((d) => d.data() as Order).sort(byCreated);
}

export async function serveOrder(id: string): Promise<boolean> {
  if (!useFirestore) {
    const order = memory.find((o) => o.id === id);
    if (!order) return false;
    order.status = "served";
    return true;
  }
  const ref = (await db()).collection(COLLECTION).doc(id);
  if (!(await ref.get()).exists) return false;
  await ref.update({ status: "served" });
  return true;
}

export const storageKind = useFirestore ? `firestore (${PROJECT_ID})` : "memory";
