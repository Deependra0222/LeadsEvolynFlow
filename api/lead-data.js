// Vercel Function: every /api/* request is rewritten here by vercel.json.
import { createServerHandler } from "../server/app.mjs";

const handle = await createServerHandler();

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
