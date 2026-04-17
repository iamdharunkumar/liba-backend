/// <reference types="nakama-runtime" />
// ─── Nakama Server Module: Multiplayer Tic-Tac-Toe ───────────────────────────
// Compiled by Nakama's TypeScript runtime (esbuild-based)
// Deploy: copy to Nakama's "lua/ts" modules folder

const moduleName = "tictactoe";

// ─── Op Codes (must match frontend) ──────────────────────────────────────────
const OpCode = {
  MOVE: 1,
  GAME_STATE: 2,
  GAME_OVER: 3,
  TIMER_TICK: 4,
  PLAYER_READY: 5,
  REJECT_MOVE: 6,
};

// ─── Config ───────────────────────────────────────────────────────────────────
const TURN_TIMER_SECONDS = 30;
const WINNING_COMBOS = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];
const LEADERBOARD_ID = "tictactoe_wins";

// ─── Types ────────────────────────────────────────────────────────────────────
type CellValue = "X" | "O" | null;

interface PlayerInfo {
  userId: string;
  username: string;
  symbol: "X" | "O";
  sessionId: string;
}

interface MatchState {
  board: CellValue[];
  players: PlayerInfo[];
  currentTurn: string;        // userId
  status: "waiting" | "playing" | "game_over" | "draw" | "opponent_left";
  winner: string | null;
  winningCells: number[] | null;
  moveCount: number;
  mode: "classic" | "timed";
  timerRemaining: number | null;
  timerHandle: number | null;
  label: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function checkWinner(board: CellValue[]): number[] | null {
  for (const combo of WINNING_COMBOS) {
    const [a, b, c] = combo;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return combo;
    }
  }
  return null;
}

function isDraw(board: CellValue[]): boolean {
  return board.every((c) => c !== null) && !checkWinner(board);
}

function encodeState(state: MatchState): string {
  return JSON.stringify({
    board: state.board,
    currentTurn: state.currentTurn,
    status: state.status,
    players: state.players.map((p) => ({
      userId: p.userId,
      username: p.username,
      symbol: p.symbol,
    })),
    winner: state.winner,
    winningCells: state.winningCells,
    moveCount: state.moveCount,
    timerRemaining: state.timerRemaining,
    mode: state.mode,
  });
}

function broadcastState(
  nk: nkruntime.Nakama,
  dispatcher: nkruntime.MatchDispatcher,
  state: MatchState
): void {
  dispatcher.broadcastMessage(
    OpCode.GAME_STATE,
    encodeState(state),
    null,       // all presences
    null,
    true
  );
}

function endGame(
  nk: nkruntime.Nakama,
  dispatcher: nkruntime.MatchDispatcher,
  state: MatchState,
  winner: string | null,
  reason: "win" | "draw" | "forfeit" | "timeout"
): MatchState {
  state.winner = winner;
  state.status = winner ? "game_over" : "draw";

  // Update leaderboard
  if (winner) {
    const loser = state.players.find((p) => p.userId !== winner);
    try {
      nk.leaderboardRecordWrite(
        LEADERBOARD_ID,
        winner,
        state.players.find((p) => p.userId === winner)?.username ?? "",
        1,
        0,
        { result: "win" },
        "increment" as any
      );
    } catch (e) { /* ignore */ }

    if (loser) {
      try {
        nk.leaderboardRecordWrite(
          LEADERBOARD_ID,
          loser.userId,
          loser.username,
          0,
          1,
          { result: "loss" },
          "increment" as any
        );
      } catch (e) { /* ignore */ }
    }
  } else if (reason === "draw") {
    for (const p of state.players) {
      try {
        nk.leaderboardRecordWrite(
          LEADERBOARD_ID,
          p.userId,
          p.username,
          0,
          1,
          { result: "draw" },
          "increment" as any
        );
      } catch (e) { /* ignore */ }
    }
  }

  // Broadcast game-over message
  dispatcher.broadcastMessage(
    OpCode.GAME_OVER,
    JSON.stringify({
      winner: state.winner,
      reason,
      board: state.board,
      winningCells: state.winningCells,
    }),
    null,
    null,
    true
  );

  return state;
}

// ─── Match Handler ────────────────────────────────────────────────────────────
var matchInit: nkruntime.MatchInitFunction<MatchState> = (
  ctx,
  logger,
  nk,
  params
) => {
  const mode = (params?.mode as "classic" | "timed") ?? "classic";
  const label = JSON.stringify({ open: true, mode });

  const state: MatchState = {
    board: Array(9).fill(null),
    players: [],
    currentTurn: "",
    status: "waiting",
    winner: null,
    winningCells: null,
    moveCount: 0,
    mode,
    timerRemaining: mode === "timed" ? TURN_TIMER_SECONDS : null,
    timerHandle: null,
    label,
  };

  return { state, tickRate: 1, label };
};

var matchJoinAttempt: nkruntime.MatchJoinAttemptFunction<MatchState> = (
  ctx,
  logger,
  nk,
  dispatcher,
  tick,
  state,
  presence,
  metadata
) => {
  // Allow join only if < 2 players and game not ended
  const canJoin =
    state.players.length < 2 &&
    (state.status === "waiting" || state.status === "playing");
  return { state, accept: canJoin };
};

var matchJoin: nkruntime.MatchJoinFunction<MatchState> = (
  ctx,
  logger,
  nk,
  dispatcher,
  tick,
  state,
  presences
) => {
  for (const p of presences) {
    const symbol: "X" | "O" = state.players.length === 0 ? "X" : "O";
    state.players.push({
      userId: p.userId,
      username: p.username,
      symbol,
      sessionId: p.sessionId,
    });
    logger.info(`${p.username} joined as ${symbol}`);
  }

  if (state.players.length === 2) {
    // Game starts
    state.status = "playing";
    state.currentTurn = state.players[0].userId;
    state.label = JSON.stringify({ open: false, mode: state.mode });
    dispatcher.matchLabelUpdate(state.label);

    if (state.mode === "timed") {
      state.timerRemaining = TURN_TIMER_SECONDS;
    }

    broadcastState(nk, dispatcher, state);
    logger.info("Game started!");
  } else {
    // Still waiting
    broadcastState(nk, dispatcher, state);
  }

  return { state };
};

var matchLeave: nkruntime.MatchLeaveFunction<MatchState> = (
  ctx,
  logger,
  nk,
  dispatcher,
  tick,
  state,
  presences
) => {
  for (const p of presences) {
    state.players = state.players.filter((pl) => pl.sessionId !== p.sessionId);
    logger.info(`${p.username} left`);
  }

  if (state.status === "playing" && state.players.length < 2) {
    // Remaining player wins by forfeit
    const remaining = state.players[0];
    if (remaining) {
      state.winningCells = null;
      state = endGame(nk, dispatcher, state, remaining.userId, "forfeit");
    } else {
      state.status = "opponent_left";
    }
  }

  return { state };
};

var matchLoop: nkruntime.MatchLoopFunction<MatchState> = (
  ctx,
  logger,
  nk,
  dispatcher,
  tick,
  state,
  messages
) => {
  // Exit if game is over
  if (state.status === "game_over" || state.status === "draw") {
    return null; // terminate match
  }

  // Handle timer (timed mode only, tick is 1/s by default)
  if (
    state.mode === "timed" &&
    state.status === "playing" &&
    state.timerRemaining !== null
  ) {
    state.timerRemaining = Math.max(0, state.timerRemaining - 1);

    // Broadcast timer tick every second
    dispatcher.broadcastMessage(
      OpCode.TIMER_TICK,
      JSON.stringify({
        remaining: state.timerRemaining,
        currentTurn: state.currentTurn,
      }),
      null,
      null,
      false
    );

    // Timeout → forfeit current player
    if (state.timerRemaining <= 0) {
      const forfeiter = state.currentTurn;
      const winner = state.players.find((p) => p.userId !== forfeiter);
      state.winningCells = null;
      state = endGame(nk, dispatcher, state, winner?.userId ?? null, "timeout");
      return state.status === "game_over" || state.status === "draw"
        ? null
        : { state };
    }
  }

  // Process incoming messages
  for (const msg of messages) {
    if (msg.opCode !== OpCode.MOVE) continue;

    const sender = state.players.find((p) => p.sessionId === msg.sender.sessionId);
    if (!sender) continue;

    // Validate it's this player's turn
    if (state.currentTurn !== sender.userId) {
      dispatcher.broadcastMessage(
        OpCode.REJECT_MOVE,
        JSON.stringify({ reason: "not_your_turn" }),
        [msg.sender],
        null,
        false
      );
      continue;
    }

    let moveData: { position: number };
    try {
      const dataStr = typeof msg.data === "string" ? msg.data : nk.binaryToString(msg.data);
      moveData = JSON.parse(dataStr);
    } catch {
      continue;
    }

    const pos = moveData.position;
    if (typeof pos !== "number" || pos < 0 || pos > 8 || state.board[pos] !== null) {
      dispatcher.broadcastMessage(
        OpCode.REJECT_MOVE,
        JSON.stringify({ reason: "invalid_position" }),
        [msg.sender],
        null,
        false
      );
      continue;
    }

    // Apply move
    state.board[pos] = sender.symbol;
    state.moveCount++;

    // Check for winner
    const winCells = checkWinner(state.board);
    if (winCells) {
      state.winningCells = winCells;
      state = endGame(nk, dispatcher, state, sender.userId, "win");
      return null; // terminate match
    }

    if (isDraw(state.board)) {
      state.winningCells = null;
      state = endGame(nk, dispatcher, state, null, "draw");
      return null; // terminate match
    }

    // Switch turn
    const next = state.players.find((p) => p.userId !== state.currentTurn);
    state.currentTurn = next?.userId ?? state.currentTurn;

    // Reset timer on new turn
    if (state.mode === "timed") {
      state.timerRemaining = TURN_TIMER_SECONDS;
    }

    broadcastState(nk, dispatcher, state);
  }

  return { state };
};

var matchTerminate: nkruntime.MatchTerminateFunction<MatchState> = (
  ctx,
  logger,
  nk,
  dispatcher,
  tick,
  state,
  graceSeconds
) => {
  logger.info("Match terminating.");
  return { state };
};

var matchSignal: nkruntime.MatchSignalFunction<MatchState> = (
  ctx,
  logger,
  nk,
  dispatcher,
  tick,
  state,
  data
) => {
  return { state, data };
};

// ─── RPC: Create Match ────────────────────────────────────────────────────────
var rpcCreateMatch: nkruntime.RpcFunction = (ctx, logger, nk, payload) => {
  let params: { mode?: string } = {};
  if (payload) {
    try {
      params = JSON.parse(payload);
    } catch {}
  }

  const mode = params.mode === "timed" ? "timed" : "classic";

  try {
    // Ensure leaderboard exists
    try {
      nk.leaderboardCreate(
        LEADERBOARD_ID,
        false,
        "desc" as any,
        "increment" as any,
        "",
        {}
      );
    } catch {}

    const matchId = nk.matchCreate(moduleName, { mode });
    return JSON.stringify({ matchId });
  } catch (e) {
    logger.error("Failed to create match: %q", e);
    throw e;
  }
};

// ─── RPC: List Open Matches ───────────────────────────────────────────────────
var rpcListOpenMatches: nkruntime.RpcFunction = (ctx, logger, nk, payload) => {
  let params: { mode?: string } = {};
  if (payload) {
    try {
      params = JSON.parse(payload);
    } catch {}
  }

  const mode = params.mode ?? "classic";

  try {
    const matches = nk.matchList(
      10,
      true,
      `{"open":true,"mode":"${mode}"}`,
      0,
      1,
      ""
    );

    return JSON.stringify({
      matches: matches.map((m) => ({
        matchId: m.matchId,
        label: m.label,
        size: m.size,
      })),
    });
  } catch (e) {
    logger.error("Failed to list matches: %q", e);
    return JSON.stringify({ matches: [] });
  }
};

// ─── Matchmaker Matched Hook ───────────────────────────────────────────────────
var matchmakerMatched: nkruntime.MatchmakerMatchedFunction = (
  ctx,
  logger,
  nk,
  matches
) => {
  try {
    // Ensure leaderboard exists
    try {
      nk.leaderboardCreate(
        LEADERBOARD_ID,
        false,
        "desc" as any,
        "increment" as any,
        "",
        {}
      );
    } catch {}

    // Determine mode from matchmaker properties
    const props = matches[0]?.properties ?? {};
    const mode = props.mode === "timed" ? "timed" : "classic";

    const matchId = nk.matchCreate(moduleName, { mode });
    logger.info("Matchmaker created match: %q", matchId);
    return matchId;
  } catch (e) {
    logger.error("Matchmaker failed: %q", e);
    return undefined;
  }
};

// ─── Register ─────────────────────────────────────────────────────────────────
function InitModule(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  initializer: nkruntime.Initializer
): void {
  // Create leaderboard on startup
  try {
    nk.leaderboardCreate(
      LEADERBOARD_ID,
      false,
      "desc" as any,
      "increment" as any,
      "",
      {}
    );
    logger.info("Leaderboard '%q' ready", LEADERBOARD_ID);
  } catch {
    // Already exists
  }

  initializer.registerMatch(moduleName, {
    matchInit: matchInit,
    matchJoinAttempt: matchJoinAttempt,
    matchJoin: matchJoin,
    matchLeave: matchLeave,
    matchLoop: matchLoop,
    matchTerminate: matchTerminate,
    matchSignal: matchSignal,
  });

  initializer.registerRpc("create_match", rpcCreateMatch);
  initializer.registerRpc("list_open_matches", rpcListOpenMatches);

  initializer.registerMatchmakerMatched(matchmakerMatched);

  logger.info("Tic-Tac-Toe module loaded ✓");
}

// Required by Nakama TypeScript runtime
// @ts-ignore
!InitModule && InitModule.bind(null);
