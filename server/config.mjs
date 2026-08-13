import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 프런트엔드와 같은 app/config 설정을 서버에서도 읽는다. 규칙의 원본은 한 곳. */
const configDir = join(dirname(fileURLToPath(import.meta.url)), "..", "app", "config");

const readJson = (name) => JSON.parse(readFileSync(join(configDir, name), "utf8"));

export const siteConfig = readJson("site.json");
export const roomsConfig = readJson("rooms.json");
export const seedConfig = readJson("seed-bookings.json");

export const ROOM_IDS = new Set(roomsConfig.map((room) => room.id));
