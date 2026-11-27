import { isIP } from "node:net";

const quietPeriod = 7 * 24 * 60 * 60_000;
const cooldowns = [15, 30, 60, 120, 240, 480, 960, 1920].map((minutes) => minutes * 60_000);
type History = { failures: number; level: number; deadline: number; activity: number };

export class PairingLimiter {
	private readonly histories = new Map<string, History>();
	constructor(
		private readonly now: () => number,
		private readonly capacity = 10_000,
	) {}

	private history(ip: string, now: number): History | undefined {
		const history = this.histories.get(ip);
		if (history && now - history.activity >= quietPeriod) {
			this.histories.delete(ip);
			return undefined;
		}
		return history;
	}

	blocked(ip: string): number | undefined {
		const now = this.now();
		const history = this.history(ip, now);
		if (!history || now >= history.deadline) return undefined;
		history.activity = now;
		return Math.ceil((history.deadline - now) / 1000);
	}

	fail(ip: string): void {
		const now = this.now();
		let history = this.history(ip, now);
		if (!history) {
			for (const [key, entry] of this.histories) {
				if (now - entry.activity >= quietPeriod) this.histories.delete(key);
			}
			if (this.histories.size >= this.capacity) {
				let oldest: string | undefined;
				for (const [key, entry] of this.histories) {
					if (oldest === undefined || entry.activity < this.histories.get(oldest)!.activity) oldest = key;
				}
				if (oldest !== undefined) this.histories.delete(oldest);
			}
			history = { failures: 0, level: 0, deadline: 0, activity: now };
			this.histories.set(ip, history);
		}
		history.activity = now;
		if (++history.failures === 5) {
			history.failures = 0;
			history.deadline = now + cooldowns[history.level]!;
			history.level = Math.min(history.level + 1, cooldowns.length - 1);
		}
	}

	success(ip: string): void {
		this.histories.delete(ip);
	}
}

export const canonicalIp = (value: string | undefined): string | undefined => {
	if (!value) return undefined;
	const ip = value.trim();
	const version = isIP(ip);
	if (version === 4) return ip;
	if (version !== 6 || ip.includes("%")) return undefined;
	const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
	const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
	if (!mapped) return canonical;
	const high = Number.parseInt(mapped[1]!, 16);
	const low = Number.parseInt(mapped[2]!, 16);
	return [high >> 8, high & 255, low >> 8, low & 255].join(".");
};
