export function dispatch(name: string) {
  if (name === "get_friend") return { status: "not_found" };
  if (name === "save_note") return { status: "invalid" };
  const card = { code: "never-raised", means: "a card, not a raise", fix: "none" };
  return { status: "unknown_door", card };
}
