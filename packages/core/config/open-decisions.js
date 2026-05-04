export const OPEN_DECISIONS = Object.freeze([
  {
    id: 'OD-001',
    title: 'Bump amount range user-configurable',
    owner: 'product',
    status: 'open',
    todo: 'TODO(OD-001): decide whether sniper1 bump range remains fixed or moves into tenant preferences.'
  },
  {
    id: 'OD-002',
    title: 'Sniper3 stale threshold',
    owner: 'product',
    status: 'open',
    todo: 'TODO(OD-002): confirm default stale threshold; current code follows 30 days from docs.'
  },
  {
    id: 'OD-003',
    title: 'Multi-account rotation in MVP scope',
    owner: 'security/product',
    status: 'open',
    todo: 'TODO(OD-003): decide MVP support before adding account-rotation config fields.'
  },
  {
    id: 'OD-004',
    title: 'Default notification channels',
    owner: 'product',
    status: 'open',
    todo: 'TODO(OD-004): choose local/system/push defaults before NotificationService implementation.'
  },
  {
    id: 'OD-005',
    title: 'Windows Service registration',
    owner: 'platform',
    status: 'open',
    todo: 'TODO(OD-005): decide whether launcher installs a Windows Service or stays foreground-only.'
  },
  {
    id: 'OD-006',
    title: 'Code signing budget',
    owner: 'release',
    status: 'open',
    todo: 'TODO(OD-006): decide signing certificate budget before M8 packaging.'
  }
]);
