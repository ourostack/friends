// MemoryRosterStore — in-memory RosterStore (test/host convenience, mirroring
// MemoryPinStore/MemoryAuditSink). One roster + one pin per accountId, held in maps;
// no fs. Covered to 100% via the account-roster + direct tests.
import type { AccountRoster, RosterPin, RosterStore } from "./roster-store"

export class MemoryRosterStore implements RosterStore {
  private readonly rosters = new Map<string, AccountRoster>()
  private readonly pins = new Map<string, RosterPin>()

  async getRoster(accountId: string): Promise<AccountRoster | null> {
    return this.rosters.get(accountId) ?? null
  }
  async putRoster(roster: AccountRoster): Promise<void> {
    this.rosters.set(roster.accountId, roster)
  }
  async getPin(accountId: string): Promise<RosterPin | null> {
    return this.pins.get(accountId) ?? null
  }
  async putPin(pin: RosterPin): Promise<void> {
    this.pins.set(pin.accountId, pin)
  }
}
