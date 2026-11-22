// A declarations module shaped like friends.actions.mts.
export default defineActions("fixture", [
  defineAction({ id: "get_friend", consent: "read" }),
  defineAction({ id: "save_note", consent: "write" }),
  other({ id: "whoami" }),
]);
