/* ═══════════════════════════════════════════════════════════
   DigiChess.com — script.js
   Full chess rules + UI logic
   Architecture allows easy Stockfish AI integration later.
═══════════════════════════════════════════════════════════ */

/* ── GAME MODE ── (change to 'ai' for future Stockfish support) */
let gameMode = "pvp"; // "pvp" | "ai" | "friend"

/* ── FIREBASE CONFIG (will initialize after SDK loads) ── */
let db = null;
const DIGICHAT_THREAD_ID = '__digichat__';
const DIGICHAT_CHAT_ID = 'DIGICHAT';
const DIGICHAT_NAME = 'DIGICHAT';
const STARTING_ELO = 400;
const MIN_ELO = 100;
const ELO_K_FACTOR = 32;

// Initialize Firebase when ready
function initFirebase() {
  try {
    if (firebase && !firebase.apps.length) {
      const firebaseConfig = {
        apiKey: "AIzaSyBWCRgFXvIpjKq9mXJYouYp20hqv-jKyH0",
        authDomain: "digichess-e858b.firebaseapp.com",
        projectId: "digichess-e858b",
        databaseURL: "https://digichess-e858b-default-rtdb.asia-southeast1.firebasedatabase.app",
        storageBucket: "digichess-e858b.firebasestorage.app",
        messagingSenderId: "689026321934",
        appId: "1:689026321934:web:a3656a9dcf581ab727b65f"
      };
      
      firebase.initializeApp(firebaseConfig);
      db = firebase.database();
    }

    // Set up auth state listener — fires immediately with current session
    firebase.auth().onAuthStateChanged(user => {
      if (user) {
        currentUser = user;
        if (user.isAnonymous) registerGuestCleanup(user.uid);
        // Logged in — fetch username from DB and update UI
        db.ref(`users/${user.uid}/username`).once('value').then(snap => {
          const username = snap.val();
          // Google users with no username yet — prompt them to choose
          if (!username && !user.isAnonymous) {
            openChooseUsernameModal(user.uid);
            return;
          }
          const displayName = username || 'Player';
          currentUsername = displayName;
          updateAccountUI(displayName);
          if (!user.isAnonymous) {
            ensureUserElo(displayName).catch(err => console.warn('Unable to initialise Elo:', err));
          }
          // Guests only get match-accepted listener (for quick play / friend game invites)
          // — no social notifications (DMs, friend requests, match challenges)
          if (!user.isAnonymous) {
            startMatchRequestListener();
            startDmNotifListener();
            startFriendRequestNotifListener();
          }
          startMatchAcceptedListener();  // guests need this for quick play pairings
        });
      } else {
        stopMatchRequestListener();
        stopDmNotifListener();
        stopFriendRequestNotifListener();
        stopActiveDmChatListener();
        currentUsername = null;
        currentUser = null;
        updateAccountUI(null);
      }
    });

  } catch (err) {
    console.error('Firebase initialization error:', err);
  }
}

/* ══════════════════════════════════════════
   CONSTANTS & PIECE DEFINITIONS
══════════════════════════════════════════ */
const PIECE_UNICODE = {
  wK: '♔', wQ: '♕', wR: '♖', wB: '♗', wN: '♘', wP: '♙',
  bK: '♚', bQ: '♛', bR: '♜', bB: '♝', bN: '♞', bP: '♟',
};

const PIECE_VALUES = { P: 1, N: 3, B: 3, R: 5, Q: 9, K: 0 };

const INITIAL_BOARD = [
  ['bR','bN','bB','bQ','bK','bB','bN','bR'],
  ['bP','bP','bP','bP','bP','bP','bP','bP'],
  [null,null,null,null,null,null,null,null],
  [null,null,null,null,null,null,null,null],
  [null,null,null,null,null,null,null,null],
  [null,null,null,null,null,null,null,null],
  ['wP','wP','wP','wP','wP','wP','wP','wP'],
  ['wR','wN','wB','wQ','wK','wB','wN','wR'],
];

/* ══════════════════════════════════════════
   GAME STATE
══════════════════════════════════════════ */
let board        = [];          // 8×8 array of piece strings or null
let currentTurn  = 'w';         // 'w' | 'b'
let selectedSq   = null;        // { row, col } or null
let legalMoves   = [];          // array of { row, col, special? }
let moveHistory  = [];          // algebraic notation strings
let stateHistory = [];          // board snapshots for undo
let lastMove     = null;        // { from, to } for highlighting
let enPassantSq  = null;        // { row, col } eligible target or null
let castlingRights = { wK: true, wQ: true, bK: true, bQ: true };
let capturedByWhite = [];       // pieces white has taken
let capturedByBlack = [];       // pieces black has taken
let isFlipped    = false;       // board orientation: false = white at bottom, true = black at bottom
let gameOver     = false;
let halfMoveClock = 0;          // for display
let aiThinking   = false;
let stockfishWorker = null;
let stockfishReady = false;
let stockfishRequestId = 0;
let stockfishPending = null;
let aiDifficulty = 'medium';
const SETTINGS_STORAGE_KEY = 'digichessUserSettings';
const DEFAULT_USER_SETTINGS = {
  boardTheme: 'classic',
  pieceStyle: 'unicode',
  moveSounds: true,
  alertSounds: true,
  defaultTimer: 600,
  legalHighlights: true,
  lastMoveHighlight: true,
  coordinates: true,
  autoFlipBlack: true,
  compactMode: false
};
let userSettings = { ...DEFAULT_USER_SETTINGS };

// Timer state
let timerWhiteSecs  = 600;
let timerBlackSecs  = 600;
let timerInterval   = null;
let timersRunning   = false;
let timerLimitSecs  = 600;

// Multiplayer state
let friendJoinCode  = null;        // current game's join code
let playerId        = null;        // unique ID for this player
let friendGameRef   = null;        // reference to current game in Firebase
let gameListener    = null;        // listener reference for unsubscribe
let myColor         = null;        // 'w' or 'b' when playing with friend
let gameSyncPollId  = null;        // backup poller for missed RTDB updates
let gameFieldListeners = [];       // child listeners for turn / moveHistory changes
let gameFieldDebounceId = null;    // debounce rapid multi-field Firebase updates

// Auth state
let currentUser     = null;        // Firebase Auth user object
let currentUsername = null;        // display username

// Friend game player names
let opponentUsername = null;       // the other player's username in a friend game
let hostUsername     = null;       // username of who created the game
let joinerUsername   = null;       // username of who joined the game
let onlinePlayerUidByColor = { w: null, b: null };
let currentGameRanked = false;
let currentGameElos = {};
let currentGameFriendRequests = {};
let currentGameFriendAccepts = {};
let currentGameFriendRemovals = {};
let currentDrawOffer = null;
let handledDrawOffers = new Set();
let drawOfferModalKey = null;
let activeGameOverModalKey = null;
let dismissedGameOverKeys = new Set();
let mirroredInGameFriendRequests = new Set();
let mirroredInGameFriendAccepts = new Set();
let mirroredInGameFriendRemovals = new Set();
let recordedGameStats = new Set();
let recordedEloGames = new Set();
let recordedFriendStats = new Set();
let onlinePositionSnapshots = [];
let onlineReviewIndex = null;
let onlineLiveSnapshot = null;

/* ══════════════════════════════════════════
   MULTIPLAYER HELPER FUNCTIONS (defined early)
══════════════════════════════════════════ */

function generatePlayerId() {
  return 'player_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
}

function generateJoinCode() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

function openPlayOnlineModal() {
  // Require any login (including guest) to play online
  if (!currentUser) {
    openAuthModal('signup');
    return;
  }
  updatePrimaryNavState('friend');
  const modal = document.getElementById('friendModal');
  modal.style.display = 'flex';
  // Reset state on open
  document.getElementById('joinError').style.display          = 'none';
  document.getElementById('joinCodeDisplay').style.display    = 'none';
  document.getElementById('friendJoinCode').value             = '';
  document.getElementById('matchmakingStatus').style.display  = 'none';
  document.getElementById('qpIdle').style.display             = 'grid';

  const rankedBtn = document.getElementById('rankedQuickPlayBtn');
  const rankedGuestMessage = document.getElementById('rankedGuestMessage');
  if (rankedBtn) rankedBtn.style.display = currentUser.isAnonymous ? 'none' : 'flex';
  if (rankedGuestMessage) rankedGuestMessage.style.display = currentUser.isAnonymous ? 'block' : 'none';

  // Hide Community & Stats section for guests — they have no friends/social features
  const communitySection = document.getElementById('onlineCommunityWrapper');
  if (communitySection) {
    communitySection.style.display = currentUser.isAnonymous ? 'none' : 'block';
  }
}

// Keep old name working (used internally by acceptMatchRequest flow)
function openFriendModal() { openPlayOnlineModal(); }

function showHomePage() {
  const home = document.getElementById('homePage');
  const game = document.getElementById('gameLayout');
  if (home) home.style.display = 'block';
  if (game) game.style.display = 'none';
  updatePrimaryNavState('home');
  loadHomepageLeaderboardPreview();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showGamePage() {
  const home = document.getElementById('homePage');
  const game = document.getElementById('gameLayout');
  if (home) home.style.display = 'none';
  if (game) game.style.display = 'grid';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function updatePrimaryNavState(active) {
  document.getElementById('btnHome')?.classList.toggle('active', active === 'home');
  document.getElementById('btnPVP')?.classList.toggle('active', active === 'pvp');
  document.getElementById('btnFriend')?.classList.toggle('active', active === 'friend');
  document.getElementById('btnAI')?.classList.toggle('active', active === 'ai');
}

function startLocalGameFromHome() {
  setGameMode('pvp');
}

function requireAccountThen(action) {
  if (!currentUser || currentUser.isAnonymous) {
    openAuthModal('signup');
    return;
  }
  action();
}

/* ══════════════════════════════════════════
   INITIALIZATION
══════════════════════════════════════════ */
function initGame() {
  aiThinking = false;
  stockfishPending = null;
  if (gameMode !== 'friend') {
    onlinePositionSnapshots = [];
    onlineReviewIndex = null;
    onlineLiveSnapshot = null;
  }
  board = INITIAL_BOARD.map(r => [...r]);
  currentTurn    = 'w';
  selectedSq     = null;
  legalMoves     = [];
  moveHistory    = [];
  stateHistory   = [];
  lastMove       = null;
  enPassantSq    = null;
  capturedByWhite = [];
  capturedByBlack = [];
  gameOver       = false;
  halfMoveClock  = 0;
  castlingRights = { wK: true, wQ: true, bK: true, bQ: true };
  renderBoard();
  renderMoveHistory();
  updateStatusBar();
  updateCapturedPieces();
  updateGameInfo();
  updateAISettingsVisibility();
  updateOnlineReviewControls();
  if (gameMode === 'ai') {
    setAIStatus('Human plays White. Stockfish plays Black.');
    ensureStockfish();
  }
}

function newGame() {
  closeModal('gameOverModal');
  stopTimers();
  if (gameMode !== 'friend') {
    timerLimitSecs = Number(userSettings.defaultTimer) || 0;
    const timerPreset = document.getElementById('timerPreset');
    if (timerPreset) timerPreset.value = String(timerLimitSecs);
  }
  resetTimers(true);
  // In online games orientation is set by setupGameListener before initGame is called.
  // For local games (pvp / ai) always start with white at the bottom.
  if (gameMode !== 'friend') {
    isFlipped = false;
  }
  initGame();
}

/* ══════════════════════════════════════════
   BOARD RENDERING
══════════════════════════════════════════ */
function renderBoard() {
  const boardEl = document.getElementById('chessboard');
  boardEl.innerHTML = '';

  // Coordinate labels
  renderCoords();

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const dispRow = isFlipped ? (7 - r) : r;
      const dispCol = isFlipped ? (7 - c) : c;

      const sq = document.createElement('div');
      sq.classList.add('square');
      sq.classList.add((dispRow + dispCol) % 2 === 0 ? 'light' : 'dark');
      sq.dataset.row = dispRow;
      sq.dataset.col = dispCol;

      // Last move highlight
      if (userSettings.lastMoveHighlight && lastMove) {
        if ((lastMove.from.row === dispRow && lastMove.from.col === dispCol) ||
            (lastMove.to.row   === dispRow && lastMove.to.col   === dispCol)) {
          sq.classList.add((dispRow + dispCol) % 2 === 0 ? 'last-move-light' : 'last-move-dark');
        }
      }

      // Selected
      if (selectedSq && selectedSq.row === dispRow && selectedSq.col === dispCol) {
        sq.classList.add('selected');
      }

      // Legal moves
      const lm = userSettings.legalHighlights ? legalMoves.find(m => m.row === dispRow && m.col === dispCol) : null;
      if (lm) {
        sq.classList.add(board[dispRow][dispCol] ? 'legal-capture' : 'legal-move');
      }

      // King in check highlight
      if (isKingInCheck(currentTurn)) {
        const kPos = findKing(currentTurn);
        if (kPos && kPos.row === dispRow && kPos.col === dispCol) {
          sq.classList.add('in-check');
        }
      }

      // Piece
      const piece = board[dispRow][dispCol];
      if (piece) {
        const p = document.createElement('span');
        p.classList.add('piece');
        const pieceColor = piece[0] === 'w' ? 'white' : 'black';
        p.classList.add(pieceColor);
        p.textContent = PIECE_UNICODE[piece];
        sq.appendChild(p);
      }

      sq.addEventListener('click', () => onSquareClick(dispRow, dispCol));
      boardEl.appendChild(sq);
    }
  }
}

function renderCoords() {
  const files = ['a','b','c','d','e','f','g','h'];
  const ranks = ['8','7','6','5','4','3','2','1'];

  const fileOrder = isFlipped ? [...files].reverse() : files;
  const rankOrder = isFlipped ? [...ranks].reverse() : ranks;

  ['fileLabelsTop','fileLabelsBottom'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = '';
    fileOrder.forEach(f => {
      const span = document.createElement('span');
      span.classList.add('coord-cell');
      span.textContent = f;
      el.appendChild(span);
    });
  });

  ['rankLabelsLeft','rankLabelsRight'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = '';
    rankOrder.forEach(r => {
      const span = document.createElement('span');
      span.classList.add('coord-cell');
      span.textContent = r;
      el.appendChild(span);
    });
  });
}

/* ══════════════════════════════════════════
   CLICK HANDLER
══════════════════════════════════════════ */
function onSquareClick(row, col) {
  if (gameOver) return;
  if (onlineReviewIndex !== null) return;

  // In online games, only allow moves on your own turn
  if (gameMode === 'friend' && myColor !== currentTurn) return;
  if (gameMode === 'ai' && currentTurn === 'b') return;

  const piece = board[row][col];

  // If a piece is already selected
  if (selectedSq) {
    const move = legalMoves.find(m => m.row === row && m.col === col);

    if (move) {
      // Execute the move
      executeMove(selectedSq.row, selectedSq.col, row, col, move.special);
      return;
    }

    // Clicked own piece — re-select
    if (piece && getPieceColor(piece) === currentTurn) {
      selectedSq = { row, col };
      legalMoves = getLegalMoves(row, col);
      renderBoard();
      return;
    }

    // Clicked empty or enemy with no move — deselect
    selectedSq = null;
    legalMoves = [];
    renderBoard();
    return;
  }

  // No piece selected yet — select if own piece
  if (piece && getPieceColor(piece) === currentTurn) {
    selectedSq = { row, col };
    legalMoves = getLegalMoves(row, col);
    renderBoard();
  }
}

/* ══════════════════════════════════════════
   MOVE EXECUTION
══════════════════════════════════════════ */
function executeMove(fromRow, fromCol, toRow, toCol, special, promotionType = null) {
  // Save state for undo
  stateHistory.push({
    board: board.map(r => [...r]),
    currentTurn,
    enPassantSq: enPassantSq ? { ...enPassantSq } : null,
    castlingRights: { ...castlingRights },
    capturedByWhite: [...capturedByWhite],
    capturedByBlack: [...capturedByBlack],
    lastMove: lastMove ? { from: { ...lastMove.from }, to: { ...lastMove.to } } : null,
    halfMoveClock,
  });

  const piece    = board[fromRow][fromCol];
  const captured = board[toRow][toCol];
  const color    = getPieceColor(piece);
  const type     = getPieceType(piece);

  // Track captured
  if (captured) {
    if (color === 'w') capturedByWhite.push(captured);
    else               capturedByBlack.push(captured);
    playSound('capture');
  } else {
    playSound('move');
  }

  let epCapture = null;

  // ── En passant capture ──
  if (special === 'enpassant') {
    const epRow = fromRow; // captured pawn is on same row as moving pawn
    epCapture = board[epRow][toCol];
    board[epRow][toCol] = null;
    if (color === 'w') capturedByWhite.push(epCapture);
    else               capturedByBlack.push(epCapture);
    playSound('capture');
  }

  // ── Castling ──
  if (special === 'castleK') {
    board[fromRow][5] = `${color}R`;
    board[fromRow][7] = null;
  }
  if (special === 'castleQ') {
    board[fromRow][3] = `${color}R`;
    board[fromRow][0] = null;
  }

  // Move piece
  board[toRow][toCol]   = piece;
  board[fromRow][fromCol] = null;

  // Update castling rights
  if (type === 'K') { castlingRights[`${color}K`] = false; castlingRights[`${color}Q`] = false; }
  if (type === 'R') {
    if (fromCol === 7) castlingRights[`${color}K`] = false;
    if (fromCol === 0) castlingRights[`${color}Q`] = false;
  }

  // Set en passant square
  enPassantSq = null;
  if (type === 'P' && Math.abs(toRow - fromRow) === 2) {
    enPassantSq = { row: (fromRow + toRow) / 2, col: fromCol };
  }

  lastMove = { from: { row: fromRow, col: fromCol }, to: { row: toRow, col: toCol } };

  // Pawn promotion
  if (type === 'P' && (toRow === 0 || toRow === 7)) {
    if (promotionType) {
      const promoType = String(promotionType).toUpperCase();
      const safePromo = ['Q', 'R', 'B', 'N'].includes(promoType) ? promoType : 'Q';
      board[toRow][toCol] = `${color}${safePromo}`;
      playSound('promote');
      const notation = buildNotation(piece, fromRow, fromCol, toRow, toCol, captured || epCapture, null, safePromo);
      halfMoveClock++;
      finishMove(notation);
      return;
    }
    showPromotionModal(color, toRow, toCol, fromRow, fromCol, captured);
    return; // renderBoard called after promotion choice
  }

  // Build algebraic notation
  const notation = buildNotation(piece, fromRow, fromCol, toRow, toCol, captured || epCapture, special);
  halfMoveClock++;
  finishMove(notation);
}

function finishMove(notation) {
  // Switch turn
  currentTurn = currentTurn === 'w' ? 'b' : 'w';
  selectedSq  = null;
  legalMoves  = [];

  // Check/checkmate/stalemate
  const inCheck   = isKingInCheck(currentTurn);
  const hasMoves  = playerHasLegalMoves(currentTurn);

  let suffix = '';
  if (!hasMoves) {
    if (inCheck) {
      suffix = '#';
      triggerGameOver('checkmate', notation + suffix);
      moveHistory.push(notation + suffix);
    } else {
      suffix = '';
      triggerGameOver('stalemate', notation);
      moveHistory.push(notation);
    }
  } else {
    if (inCheck) suffix = '+';
    moveHistory.push(notation + suffix);
  }

  renderBoard();
  renderMoveHistory();
  updateStatusBar(inCheck && hasMoves);
  updateCapturedPieces();
  updateGameInfo();
  updateTimerActiveState();

  if (gameMode === 'ai' && currentTurn === 'b' && !gameOver) {
    setTimeout(makeAIMove, 400);
  }
  
  // Sync to Firebase if playing with friend
  if (gameMode === 'friend') {
    rememberOnlinePositionSnapshot();
    syncMoveToFriend(notation);
  }
}

/* ══════════════════════════════════════════
   STOCKFISH AI
══════════════════════════════════════════ */
const AI_DIFFICULTIES = {
  beginner: { label: 'Beginner', skill: 0, depth: 1, movetime: 250 },
  easy:     { label: 'Easy',     skill: 3, depth: 3, movetime: 400 },
  medium:   { label: 'Medium',   skill: 8, depth: 6, movetime: 650 },
  hard:     { label: 'Hard',     skill: 14, depth: 10, movetime: 950 },
  expert:   { label: 'Expert',   skill: 20, depth: 14, movetime: 1300 }
};

function ensureStockfish() {
  if (stockfishWorker) return stockfishWorker;
  try {
    stockfishWorker = new Worker('assets/stockfish.js');
    stockfishWorker.onmessage = handleStockfishMessage;
    stockfishWorker.onerror = err => {
      console.error('Stockfish worker error:', err);
      setAIStatus('Stockfish failed to load. Try refreshing the page.');
      aiThinking = false;
    };
    sendStockfish('uci');
    sendStockfish('isready');
    configureStockfishDifficulty();
    return stockfishWorker;
  } catch (err) {
    console.error('Unable to start Stockfish:', err);
    setAIStatus('Stockfish is unavailable in this browser.');
    return null;
  }
}

function sendStockfish(command) {
  if (stockfishWorker) stockfishWorker.postMessage(command);
}

function handleStockfishMessage(event) {
  const line = String(event.data || '');
  if (line === 'uciok' || line === 'readyok') {
    stockfishReady = true;
    return;
  }
  if (!line.startsWith('bestmove')) return;

  const bestMove = line.split(/\s+/)[1];
  const pending = stockfishPending;
  stockfishPending = null;
  aiThinking = false;

  if (!pending || pending.id !== stockfishRequestId || gameMode !== 'ai' || currentTurn !== 'b' || gameOver) return;
  applyStockfishMove(bestMove);
}

function configureStockfishDifficulty() {
  const config = AI_DIFFICULTIES[aiDifficulty] || AI_DIFFICULTIES.medium;
  sendStockfish('setoption name Skill Level value ' + config.skill);
  sendStockfish('setoption name Hash value 16');
  sendStockfish('isready');
}

function makeAIMove() {
  if (gameMode !== 'ai' || currentTurn !== 'b' || gameOver || aiThinking) return;
  const worker = ensureStockfish();
  if (!worker) return;

  const config = AI_DIFFICULTIES[aiDifficulty] || AI_DIFFICULTIES.medium;
  const fen = generateFEN();
  aiThinking = true;
  stockfishRequestId++;
  stockfishPending = { id: stockfishRequestId, fen };
  setAIStatus(`${config.label} Stockfish is thinking...`);

  configureStockfishDifficulty();
  sendStockfish('ucinewgame');
  sendStockfish('position fen ' + fen);
  sendStockfish(`go depth ${config.depth} movetime ${config.movetime}`);
}

function applyStockfishMove(uciMove) {
  if (!uciMove || uciMove === '(none)') return;
  const parsed = parseUCIMove(uciMove);
  if (!parsed) {
    console.warn('Invalid Stockfish move:', uciMove);
    return;
  }

  const legal = getLegalMoves(parsed.from.row, parsed.from.col)
    .find(move => move.row === parsed.to.row && move.col === parsed.to.col);
  if (!legal) {
    console.warn('Stockfish suggested illegal move:', uciMove, generateFEN());
    return;
  }

  executeMove(
    parsed.from.row,
    parsed.from.col,
    parsed.to.row,
    parsed.to.col,
    legal.special,
    parsed.promotion
  );
  setAIStatus(`Stockfish played ${uciMove}.`);
}

function parseUCIMove(uciMove) {
  const move = String(uciMove).trim().toLowerCase();
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)) return null;
  return {
    from: algebraicToRowCol(move.slice(0, 2)),
    to: algebraicToRowCol(move.slice(2, 4)),
    promotion: move[4] ? move[4].toUpperCase() : null
  };
}

function algebraicToRowCol(square) {
  const files = 'abcdefgh';
  return {
    row: 8 - Number(square[1]),
    col: files.indexOf(square[0])
  };
}

function changeAIDifficulty() {
  const select = document.getElementById('aiDifficultySelect');
  aiDifficulty = select?.value || 'medium';
  configureStockfishDifficulty();
  const config = AI_DIFFICULTIES[aiDifficulty] || AI_DIFFICULTIES.medium;
  setAIStatus(`Difficulty set to ${config.label}. Human plays White.`);
}

function updateAISettingsVisibility() {
  const card = document.getElementById('aiSettingsCard');
  if (card) card.style.display = gameMode === 'ai' ? 'block' : 'none';
}

function setAIStatus(message) {
  const status = document.getElementById('aiStatus');
  if (status) status.textContent = message;
}

function getAllLegalMovesForColor(color) {
  const moves = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (p && getPieceColor(p) === color) {
        const legal = getLegalMoves(r, c);
        legal.forEach(m => moves.push({ fromRow: r, fromCol: c, toRow: m.row, toCol: m.col, special: m.special }));
      }
    }
  }
  return moves;
}

/* ══════════════════════════════════════════
   LEGAL MOVE GENERATION
══════════════════════════════════════════ */
function getLegalMoves(row, col) {
  const piece  = board[row][col];
  if (!piece) return [];
  const color  = getPieceColor(piece);
  const type   = getPieceType(piece);
  const pseudo = getPseudoMoves(row, col, piece, color, type);

  // Filter: move must not leave own king in check
  return pseudo.filter(m => {
    const savedBoard   = board.map(r => [...r]);
    const savedEP      = enPassantSq ? { ...enPassantSq } : null;

    // Apply move
    board[m.row][m.col] = piece;
    board[row][col]     = null;

    // Handle en passant removal
    if (m.special === 'enpassant') board[row][m.col] = null;
    // Handle castling rook
    if (m.special === 'castleK') { board[row][5] = `${color}R`; board[row][7] = null; }
    if (m.special === 'castleQ') { board[row][3] = `${color}R`; board[row][0] = null; }

    const safe = !isKingInCheck(color);

    // Restore board
    board = savedBoard;
    enPassantSq = savedEP;

    return safe;
  });
}

function getPseudoMoves(row, col, piece, color, type) {
  const moves = [];
  const opp   = color === 'w' ? 'b' : 'w';

  const addIfValid = (r, c, special) => {
    if (r < 0 || r > 7 || c < 0 || c > 7) return false;
    const target = board[r][c];
    if (target && getPieceColor(target) === color) return false;
    moves.push({ row: r, col: c, special });
    return !target; // return true if square was empty (can continue sliding)
  };

  switch (type) {
    case 'P': {
      const dir  = color === 'w' ? -1 : 1;
      const start = color === 'w' ? 6 : 1;
      // Forward
      if (!board[row + dir]?.[col]) {
        moves.push({ row: row + dir, col });
        if (row === start && !board[row + 2 * dir]?.[col]) {
          moves.push({ row: row + 2 * dir, col });
        }
      }
      // Captures
      [-1, 1].forEach(dc => {
        const nr = row + dir, nc = col + dc;
        if (nr >= 0 && nr <= 7 && nc >= 0 && nc <= 7) {
          if (board[nr][nc] && getPieceColor(board[nr][nc]) === opp) {
            moves.push({ row: nr, col: nc });
          }
          // En passant
          if (enPassantSq && enPassantSq.row === nr && enPassantSq.col === nc) {
            moves.push({ row: nr, col: nc, special: 'enpassant' });
          }
        }
      });
      break;
    }
    case 'N': {
      [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]
        .forEach(([dr,dc]) => addIfValid(row+dr, col+dc));
      break;
    }
    case 'B': {
      [[-1,-1],[-1,1],[1,-1],[1,1]].forEach(([dr,dc]) => {
        for (let i = 1; i < 8; i++) if (!addIfValid(row+dr*i, col+dc*i)) break;
      });
      break;
    }
    case 'R': {
      [[-1,0],[1,0],[0,-1],[0,1]].forEach(([dr,dc]) => {
        for (let i = 1; i < 8; i++) if (!addIfValid(row+dr*i, col+dc*i)) break;
      });
      break;
    }
    case 'Q': {
      [[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]].forEach(([dr,dc]) => {
        for (let i = 1; i < 8; i++) if (!addIfValid(row+dr*i, col+dc*i)) break;
      });
      break;
    }
    case 'K': {
      [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]
        .forEach(([dr,dc]) => addIfValid(row+dr, col+dc));
      // Castling
      const rank = color === 'w' ? 7 : 0;
      if (row === rank && col === 4) {
        // Kingside
        if (castlingRights[`${color}K`] &&
            !board[rank][5] && !board[rank][6] &&
            !isSquareAttacked(rank, 4, opp) &&
            !isSquareAttacked(rank, 5, opp) &&
            !isSquareAttacked(rank, 6, opp)) {
          moves.push({ row: rank, col: 6, special: 'castleK' });
        }
        // Queenside
        if (castlingRights[`${color}Q`] &&
            !board[rank][3] && !board[rank][2] && !board[rank][1] &&
            !isSquareAttacked(rank, 4, opp) &&
            !isSquareAttacked(rank, 3, opp) &&
            !isSquareAttacked(rank, 2, opp)) {
          moves.push({ row: rank, col: 2, special: 'castleQ' });
        }
      }
      break;
    }
  }
  return moves;
}

/* ══════════════════════════════════════════
   CHECK / CHECKMATE / STALEMATE
══════════════════════════════════════════ */
function isKingInCheck(color) {
  const kPos = findKing(color);
  if (!kPos) return false;
  const opp = color === 'w' ? 'b' : 'w';
  return isSquareAttacked(kPos.row, kPos.col, opp);
}

function isSquareAttacked(row, col, byColor) {
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (!p || getPieceColor(p) !== byColor) continue;
      const pseudo = getPseudoMoves(r, c, p, byColor, getPieceType(p));
      if (pseudo.some(m => m.row === row && m.col === col)) return true;
    }
  }
  return false;
}

function findKing(color) {
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++)
      if (board[r][c] === `${color}K`) return { row: r, col: c };
  return null;
}

function playerHasLegalMoves(color) {
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++)
      if (board[r][c] && getPieceColor(board[r][c]) === color)
        if (getLegalMoves(r, c).length > 0) return true;
  return false;
}

/* ══════════════════════════════════════════
   PAWN PROMOTION
══════════════════════════════════════════ */
function showPromotionModal(color, toRow, toCol, fromRow, fromCol, oldCaptured) {
  const modal = document.getElementById('promotionModal');
  const choices = document.getElementById('promotionChoices');
  choices.innerHTML = '';

  const pieces = ['Q', 'R', 'B', 'N'];
  pieces.forEach(type => {
    const key = `${color}${type}`;
    const btn = document.createElement('button');
    btn.classList.add('promote-btn');
    const pieceSpan = document.createElement('span');
    pieceSpan.classList.add('piece');
    pieceSpan.classList.add(color === 'w' ? 'white' : 'black');
    pieceSpan.textContent = PIECE_UNICODE[key];
    btn.appendChild(pieceSpan);
    btn.title = { Q:'Queen', R:'Rook', B:'Bishop', N:'Knight' }[type];
    btn.onclick = () => {
      board[toRow][toCol] = key;
      modal.style.display = 'none';
      playSound('promote');
      const notation = buildNotation(`${color}P`, fromRow, fromCol, toRow, toCol, oldCaptured, null, type);
      halfMoveClock++;
      finishMove(notation);
    };
    choices.appendChild(btn);
  });

  modal.style.display = 'flex';
}

/* ══════════════════════════════════════════
   ALGEBRAIC NOTATION
══════════════════════════════════════════ */
function buildNotation(piece, fromRow, fromCol, toRow, toCol, captured, special, promoType) {
  const type  = getPieceType(piece);
  const files = 'abcdefgh';
  const ranks = '87654321';
  const toSq  = files[toCol] + ranks[toRow];

  if (special === 'castleK') return 'O-O';
  if (special === 'castleQ') return 'O-O-O';

  let notation = '';
  if (type !== 'P') {
    notation += type;
    // Disambiguation (simplified)
    const ambig = [];
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        if ((r !== fromRow || c !== fromCol) && board[r][c] === piece) {
          const moves = getLegalMoves(r, c);
          if (moves.some(m => m.row === toRow && m.col === toCol)) ambig.push({ r, c });
        }
      }
    }
    if (ambig.length > 0) {
      if (ambig.every(a => a.c !== fromCol)) notation += files[fromCol];
      else if (ambig.every(a => a.r !== fromRow)) notation += ranks[fromRow];
      else notation += files[fromCol] + ranks[fromRow];
    }
  } else if (captured || special === 'enpassant') {
    notation += files[fromCol];
  }

  if (captured || special === 'enpassant') notation += 'x';
  notation += toSq;
  if (promoType) notation += '=' + promoType;
  return notation;
}

/* ══════════════════════════════════════════
   GAME OVER
══════════════════════════════════════════ */
function triggerGameOver(reason, lastNotation, forcedLoserColor = null) {
  gameOver = true;
  stopTimers();

  // In online mode use usernames, otherwise use colour names
  const loserColor   = forcedLoserColor || (currentTurn === 'w' ? 'White' : 'Black');
  const winnerColor  = forcedLoserColor
    ? (forcedLoserColor === 'White' ? 'Black' : 'White')
    : (currentTurn === 'w' ? 'Black' : 'White'); // who just moved wins

  // Resolve display names using myColor so it works regardless of who is host/joiner
  function nameForColor(color) {
    if (gameMode !== 'friend') return color;
    if (myColor === 'w') {
      // I'm white: white=me, black=opponent
      if (color === 'White') return currentUsername || color;
      return opponentUsername || hostUsername || color;
    } else if (myColor === 'b') {
      // I'm black: black=me, white=opponent
      if (color === 'Black') return currentUsername || color;
      return opponentUsername || joinerUsername || color;
    }
    // Fallback: joiner=white, host=black
    return color === 'White' ? (joinerUsername || color) : (hostUsername || color);
  }

  const winnerName = nameForColor(winnerColor);
  const loserName  = nameForColor(loserColor);

  let title = '', sub = '', icon = '♚';
  if (reason === 'checkmate') {
    title = `${winnerName} wins!`;
    sub   = `Checkmate — ${winnerName} delivers the final blow.`;
    icon  = winnerColor === 'White' ? '♔' : '♚';
    playSound('checkmate');
  } else if (reason === 'stalemate') {
    title = 'Stalemate!';
    sub   = 'No legal moves — the game ends in a draw.';
    icon  = '♟';
  } else if (reason === 'resign') {
    title = `${winnerName} wins!`;
    sub   = `${loserName} resigned.`;
    icon  = winnerColor === 'White' ? '♔' : '♚';
  } else if (reason === 'timeout') {
    title = `${winnerName} wins on time!`;
    sub   = `${loserName}'s clock reached 0.`;
    icon  = '⏱';
  }

  showGameOverModal(title, sub, icon);

  // Sync game over state to Firebase for online games
  if (gameMode === 'friend' && friendGameRef) {
    friendGameRef.update({
      ...gameStateForFirebase(),
      gameOver:        true,
      gameOverReason:  reason,
      gameOverWinner:  winnerColor,   // 'White' or 'Black'
      gameOverTitle:   title,
      gameOverSub:     sub,
      gameOverIcon:    icon,
      timerWhiteSecs:  timerWhiteSecs,
      timerBlackSecs:  timerBlackSecs,
      timerLimitSecs:  timerLimitSecs,
      drawOffer:       null,
      rematchRequest:  null           // clear any prior rematch on new game-over
    });
  }
}

/**
 * Renders the game-over modal. Pass rematchPending=true when the other player
 * has already requested a rematch, so the button says "Accept Rematch".
 */
function showGameOverModal(title, sub, icon, rematchPending = false, modalKey = null) {
  activeGameOverModalKey = modalKey;
  setTimeout(() => {
    document.getElementById('gameOverIcon').textContent  = icon;
    document.getElementById('gameOverTitle').textContent = title;
    document.getElementById('gameOverSub').textContent   = sub;
    document.getElementById('gameOverModal').style.display = 'flex';
    document.getElementById('infoStatus').textContent    = 'Ended';
    document.getElementById('infoStatus').className      = 'status-ended';

    const playAgainBtn = document.getElementById('playAgainBtn');
    const rematchBtn   = document.getElementById('rematchBtn');
    const dismissBtn   = document.getElementById('gameOverDismissBtn');
    if (playAgainBtn) {
      playAgainBtn.textContent = 'Play Again';
      playAgainBtn.disabled = false;
      playAgainBtn.onclick = newGame;
    }
    if (rematchBtn) rematchBtn.disabled = false;
    if (dismissBtn) dismissBtn.style.display = 'inline-flex';
    if (gameMode === 'friend') {
      if (playAgainBtn) playAgainBtn.style.display = 'none';
      if (rematchBtn) {
        rematchBtn.style.display = 'inline-flex';
        if (rematchPending) {
          rematchBtn.textContent = 'Accept Rematch';
          rematchBtn.onclick = acceptRematch;
        } else {
          rematchBtn.textContent = 'Request Rematch';
          rematchBtn.onclick = requestRematch;
        }
      }
    } else {
      if (playAgainBtn) playAgainBtn.style.display = 'inline-flex';
      if (rematchBtn)   rematchBtn.style.display   = 'none';
    }
  }, 300);
}

function dismissGameOverModal() {
  if (activeGameOverModalKey) dismissedGameOverKeys.add(activeGameOverModalKey);
  closeModal('gameOverModal');
}

function showDrawOfferModal(offer) {
  if (!offer || offer.fromUid === currentUser?.uid) return;
  const offerKey = `${offer.fromUid}_${offer.requestedAt || 'pending'}`;
  if (drawOfferModalKey === offerKey) return;
  drawOfferModalKey = offerKey;

  setTimeout(() => {
    document.getElementById('gameOverIcon').textContent  = '½';
    document.getElementById('gameOverTitle').textContent = `${sanitizePlayerName(offer.fromUsername, 'Opponent')} has requested a draw`;
    document.getElementById('gameOverSub').textContent   = 'Accepting will end this game as a draw.';
    document.getElementById('gameOverModal').style.display = 'flex';

    const playAgainBtn = document.getElementById('playAgainBtn');
    const rematchBtn   = document.getElementById('rematchBtn');
    const dismissBtn   = document.getElementById('gameOverDismissBtn');
    if (dismissBtn) dismissBtn.style.display = 'none';
    if (playAgainBtn) {
      playAgainBtn.style.display = 'inline-flex';
      playAgainBtn.textContent = 'Accept';
      playAgainBtn.disabled = false;
      playAgainBtn.onclick = acceptDrawOffer;
    }
    if (rematchBtn) {
      rematchBtn.style.display = 'inline-flex';
      rematchBtn.textContent = 'Decline';
      rematchBtn.disabled = false;
      rematchBtn.onclick = declineDrawOffer;
    }
  }, 120);
}

function clearDrawOfferModalIfOpen() {
  if (!drawOfferModalKey) return;
  drawOfferModalKey = null;
  closeModal('gameOverModal');
}

function requestDraw() {
  if (gameOver) return;
  if (gameMode !== 'friend' || !friendGameRef || !currentUser) {
    alert('Draw offers are only available in online games.');
    return;
  }
  const offer = {
    fromUid: currentUser.uid,
    fromUsername: sanitizePlayerName(currentUsername, 'Player'),
    requestedAt: firebase.database.ServerValue.TIMESTAMP
  };
  friendGameRef.child('drawOffer').set(offer).then(() => {
    const btn = document.getElementById('drawOfferBtn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Draw Requested';
    }
  }).catch(err => {
    console.error('Draw request failed:', err);
    alert('Unable to send draw request right now.');
  });
}

function acceptDrawOffer() {
  if (!friendGameRef || !currentDrawOffer || !currentUser) return;
  gameOver = true;
  stopTimers();
  friendGameRef.update({
    ...gameStateForFirebase(),
    gameOver:        true,
    gameOverReason:  'agreedDraw',
    gameOverWinner:  'Draw',
    gameOverTitle:   'Draw',
    gameOverSub:     'Both players have accepted a draw.',
    gameOverIcon:    '½',
    drawOffer:       null,
    timerWhiteSecs:  timerWhiteSecs,
    timerBlackSecs:  timerBlackSecs,
    timerLimitSecs:  timerLimitSecs,
    rematchRequest:  null
  }).catch(err => {
    console.error('Accept draw failed:', err);
  });
}

function declineDrawOffer() {
  if (!friendGameRef) return;
  friendGameRef.child('drawOffer').remove().then(() => {
    clearDrawOfferModalIfOpen();
  }).catch(err => {
    console.error('Decline draw failed:', err);
  });
}

function handleDrawOfferSnapshot(gameData) {
  const btn = document.getElementById('drawOfferBtn');
  const offer = gameData?.drawOffer || null;

  if (!offer) {
    currentDrawOffer = null;
    if (!gameData?.gameOver) drawOfferModalKey = null;
    if (btn && !gameOver) {
      btn.disabled = false;
      btn.innerHTML = '<svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16"><path fill-rule="evenodd" d="M4 5a2 2 0 012-2h8a2 2 0 012 2v10a2 2 0 01-2 2H6a2 2 0 01-2-2V5zm3 3a1 1 0 000 2h6a1 1 0 100-2H7zm0 4a1 1 0 100 2h6a1 1 0 100-2H7z" clip-rule="evenodd"/></svg> Draw';
    }
    return;
  }

  currentDrawOffer = offer;
  if (offer.fromUid === currentUser?.uid) {
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Draw Requested';
    }
    return;
  }

  const offerKey = `${offer.fromUid}_${offer.requestedAt || 'pending'}`;
  if (!handledDrawOffers.has(offerKey) && !gameData.gameOver) {
    handledDrawOffers.add(offerKey);
    showDrawOfferModal(offer);
  }
}

function onlineGameOverKey(gameData) {
  if (!gameData?.gameOver || !gameData.gameOverReason) return null;
  return safeDbKey(`${friendJoinCode || 'game'}_${gameData.createdAt || 'created'}_${gameData.gameOverReason}_${gameData.gameOverWinner || 'none'}`);
}

/* ══════════════════════════════════════════
   UNDO
══════════════════════════════════════════ */
function undoMove() {
  if (gameMode === 'friend') {
    stepOnlineBoardReviewBack();
    return;
  }

  if (stateHistory.length === 0) return;
  const prev = stateHistory.pop();
  board           = prev.board;
  currentTurn     = prev.currentTurn;
  enPassantSq     = prev.enPassantSq;
  castlingRights  = prev.castlingRights;
  capturedByWhite = prev.capturedByWhite;
  capturedByBlack = prev.capturedByBlack;
  lastMove        = prev.lastMove;
  halfMoveClock   = prev.halfMoveClock;
  gameOver        = false;
  if (moveHistory.length > 0) moveHistory.pop();
  selectedSq  = null;
  legalMoves  = [];
  renderBoard();
  renderMoveHistory();
  updateStatusBar();
  if (onlineReviewIndex !== null) {
    const statusMsg = document.getElementById('statusMsg');
    if (statusMsg) {
      statusMsg.textContent = `Viewing move ${onlineReviewIndex} of ${onlinePositionSnapshots.length - 1}`;
      statusMsg.className = 'status-message normal';
    }
  }
  updateCapturedPieces();
  updateGameInfo();
}

function cloneBoardState(b) {
  return b.map(row => [...row]);
}

function createBoardSnapshot() {
  return {
    board: cloneBoardState(board),
    currentTurn,
    moveHistory: [...moveHistory],
    lastMove: lastMove ? { from: { ...lastMove.from }, to: { ...lastMove.to } } : null,
    enPassantSq: enPassantSq ? { ...enPassantSq } : null,
    castlingRights: { ...castlingRights },
    capturedByWhite: [...capturedByWhite],
    capturedByBlack: [...capturedByBlack],
    halfMoveClock,
    gameOver
  };
}

function applyBoardSnapshotForDisplay(snapshot) {
  if (!snapshot) return;
  board           = cloneBoardState(snapshot.board);
  currentTurn     = snapshot.currentTurn;
  moveHistory     = [...snapshot.moveHistory];
  lastMove        = snapshot.lastMove ? { from: { ...snapshot.lastMove.from }, to: { ...snapshot.lastMove.to } } : null;
  enPassantSq     = snapshot.enPassantSq ? { ...snapshot.enPassantSq } : null;
  castlingRights  = { ...snapshot.castlingRights };
  capturedByWhite = [...snapshot.capturedByWhite];
  capturedByBlack = [...snapshot.capturedByBlack];
  halfMoveClock   = snapshot.halfMoveClock;
  gameOver        = snapshot.gameOver;
  selectedSq      = null;
  legalMoves      = [];
  renderBoard();
  renderMoveHistory();
  updateStatusBar();
  updateCapturedPieces();
  updateGameInfo();
}

function rememberOnlinePositionSnapshot() {
  if (gameMode !== 'friend') return;
  const snapshot = createBoardSnapshot();
  onlineLiveSnapshot = snapshot;
  onlinePositionSnapshots[moveHistory.length] = snapshot;
  onlinePositionSnapshots = onlinePositionSnapshots.slice(0, moveHistory.length + 1);
  updateOnlineReviewControls();
}

function stepOnlineBoardReviewBack() {
  if (gameMode !== 'friend' || onlinePositionSnapshots.length <= 1) return;
  if (onlineReviewIndex === null) {
    onlineLiveSnapshot = createBoardSnapshot();
    onlineReviewIndex = Math.max(0, moveHistory.length - 1);
  } else {
    onlineReviewIndex = Math.max(0, onlineReviewIndex - 1);
  }

  const snapshot = onlinePositionSnapshots[onlineReviewIndex];
  if (!snapshot) {
    resetOnlineBoardView();
    return;
  }
  stopTimers();
  applyBoardSnapshotForDisplay(snapshot);
  updateOnlineReviewControls();
}

function resetOnlineBoardView() {
  if (onlineReviewIndex === null && gameMode !== 'friend') return;
  onlineReviewIndex = null;
  if (onlineLiveSnapshot) applyBoardSnapshotForDisplay(onlineLiveSnapshot);
  if (gameMode === 'friend' && !gameOver && timerLimitSecs > 0) startTimers();
  updateOnlineReviewControls();
}

function exitOnlineBoardReviewForRemoteUpdate() {
  const wasReviewing = onlineReviewIndex !== null;
  onlineReviewIndex = null;
  updateOnlineReviewControls();
  return wasReviewing;
}

function updateOnlineReviewControls() {
  const resetBtn = document.getElementById('resetBoardViewBtn');
  if (resetBtn) {
    resetBtn.style.display = gameMode === 'friend' ? 'inline-flex' : 'none';
    resetBtn.disabled = onlineReviewIndex === null;
  }
  document.body?.classList.toggle('online-reviewing-board', onlineReviewIndex !== null);
}

/* ══════════════════════════════════════════
   RESIGN
══════════════════════════════════════════ */
function resignGame() {
  if (gameOver) return;
  const resigningColor = gameMode === 'friend' && myColor
    ? (myColor === 'w' ? 'White' : 'Black')
    : (currentTurn === 'w' ? 'White' : 'Black');
  triggerGameOver('resign', '', resigningColor);
  gameOver = true;
  updateStatusBar();
}
/* ══════════════════════════════════════════
   FLIP BOARD
══════════════════════════════════════════ */
function flipBoard() {
  isFlipped = !isFlipped;
  renderBoard();
}

function shouldAutoFlipForBlack(color) {
  return userSettings.autoFlipBlack && color === 'b';
}

/* ══════════════════════════════════════════
   UI UPDATES
══════════════════════════════════════════ */
function updateStatusBar(inCheck) {
  const turnText  = document.getElementById('turnText');
  const statusMsg = document.getElementById('statusMsg');
  const pulseDot  = document.getElementById('pulseDot');

  if (gameOver) {
    turnText.textContent = 'Game over';
    statusMsg.textContent = '';
    pulseDot.classList.add('paused');
    return;
  }

  turnText.textContent = currentTurn === 'w' ? 'White to move' : 'Black to move';
  pulseDot.classList.toggle('dot-black-turn', currentTurn === 'b');
  pulseDot.classList.remove('paused');

  if (inCheck) {
    statusMsg.textContent = '⚠ Check!';
    statusMsg.className   = 'status-message check';
    playSound('check');
  } else {
    statusMsg.textContent = '';
    statusMsg.className   = 'status-message';
  }
}

function renderMoveHistory() {
  const list  = document.getElementById('moveList');
  const count = document.getElementById('moveCount');
  list.innerHTML = '';

  count.textContent = `${moveHistory.length} ${moveHistory.length === 1 ? 'move' : 'moves'}`;

  for (let i = 0; i < moveHistory.length; i += 2) {
    const row = document.createElement('div');
    row.classList.add('move-row');

    const numEl   = document.createElement('span');
    numEl.classList.add('move-num');
    numEl.textContent = (i / 2 + 1) + '.';

    const whiteEl = document.createElement('span');
    whiteEl.classList.add('move-cell');
    whiteEl.textContent = moveHistory[i] || '';
    if (i === moveHistory.length - 1 || i === moveHistory.length - 2) {
      whiteEl.classList.add('latest');
    }

    const blackEl = document.createElement('span');
    blackEl.classList.add('move-cell');
    blackEl.textContent = moveHistory[i + 1] || '';
    if (i + 1 === moveHistory.length - 1) blackEl.classList.add('latest');

    row.appendChild(numEl);
    row.appendChild(whiteEl);
    row.appendChild(blackEl);
    list.appendChild(row);
  }

  // Scroll to bottom
  list.scrollTop = list.scrollHeight;

  document.getElementById('infoMoves').textContent = moveHistory.length;
}

function updateCapturedPieces() {
  const toHTML = pieces => {
    if (pieces.length === 0) return '<span style="color:var(--text-muted);font-size:0.72rem;">none</span>';
    // Sort by value descending
    const sorted = [...pieces].sort((a, b) =>
      (PIECE_VALUES[b[1]] || 0) - (PIECE_VALUES[a[1]] || 0)
    );
    return sorted.map(p => {
      const pieceColor = p[0] === 'w' ? 'white' : 'black';
      return `<span class="piece ${pieceColor}" title="${p}" style="font-size: 1.15rem;">${PIECE_UNICODE[p]}</span>`;
    }).join('');
  };
  document.getElementById('capturedByWhite').innerHTML = toHTML(capturedByWhite);
  document.getElementById('capturedByBlack').innerHTML = toHTML(capturedByBlack);
}

function updateGameInfo() {
  document.getElementById('infoMode').textContent   = gameMode === 'ai' ? 'vs AI' : gameMode === 'friend' ? 'Online' : 'PvP';
  document.getElementById('infoMoves').textContent  = moveHistory.length;
  const rankedRow = document.getElementById('infoRankedRow');
  const rankedStatus = document.getElementById('infoRankedStatus');
  if (rankedRow) rankedRow.style.display = gameMode === 'friend' ? 'flex' : 'none';
  if (rankedStatus) {
    rankedStatus.textContent = currentGameRanked ? 'Ranked' : 'Unranked';
    rankedStatus.style.color = currentGameRanked ? 'var(--green-bright)' : 'var(--text-secondary)';
  }
  if (!gameOver) {
    document.getElementById('infoStatus').textContent = 'Active';
    document.getElementById('infoStatus').className  = 'status-active';
  }

  // Player name rows in game info
  const playerNamesSection = document.getElementById('playerNamesSection');
  if (gameMode === 'friend' && hostUsername && joinerUsername) {
    // Determine which player is white and which is black based on hostColor.
    // In the standard flow host=black, joiner=white. But if the host chose white
    // via the color picker, it's flipped. Use myColor + currentUsername to sort.
    let whitePlayer, blackPlayer;
    if (myColor === 'w') {
      // I am white — currentUsername is the white player
      whitePlayer = currentUsername;
      blackPlayer = (hostUsername === currentUsername) ? joinerUsername : hostUsername;
    } else if (myColor === 'b') {
      // I am black — currentUsername is the black player
      blackPlayer = currentUsername;
      whitePlayer = (joinerUsername === currentUsername) ? hostUsername : joinerUsername;
    } else {
      // Local game fallback
      whitePlayer = joinerUsername;
      blackPlayer = hostUsername;
    }

    const myName = currentUsername;
    document.getElementById('infoWhitePlayer').innerHTML = formatOnlinePlayerLabel('w', whitePlayer);
    document.getElementById('infoBlackPlayer').innerHTML = formatOnlinePlayerLabel('b', blackPlayer);

    // For each opponent slot, check friendship and show the right button
    updatePlayerSlotButton('White', whitePlayer, myName);
    updatePlayerSlotButton('Black', blackPlayer, myName);

    if (playerNamesSection) playerNamesSection.style.display = 'block';
  } else {
    if (playerNamesSection) playerNamesSection.style.display = 'none';
    hidePlayerSlotButtons();
  }
}

function formatOnlinePlayerLabel(color, playerName) {
  const safeName = sanitizePlayerName(playerName, 'Player');
  if (!currentGameRanked) return safeName;
  const uid = onlinePlayerUidByColor[color];
  const elo = uid ? currentGameElos[uid] : null;
  if (!elo) return safeName;
  return `<span class="elo-badge">${normalizeElo(elo)}</span> ${safeName}`;
}

function hidePlayerSlotButtons() {
  ['White', 'Black'].forEach(color => {
    const addBtn    = document.getElementById(`addFriend${color}`);
    const friendBtn = document.getElementById(`alreadyFriend${color}`);
    if (addBtn) addBtn.style.display = 'none';
    if (friendBtn) friendBtn.style.display = 'none';
  });
}

/**
 * Shows the correct icon for a player slot:
 *  - nothing if it's the current player
 *  - green "already friends" icon (opens friends modal) if already friends
 *  - green "add friend" icon if not yet friends
 */
async function updatePlayerSlotButton(color, playerName, myName) {
  const addBtn     = document.getElementById(`addFriend${color}`);
  const friendBtn  = document.getElementById(`alreadyFriend${color}`);
  if (!addBtn || !friendBtn) return;

  // Hide both to start
  addBtn.style.display    = 'none';
  friendBtn.style.display = 'none';
  addBtn.disabled = false;
  addBtn.classList.remove('request-sent');
  addBtn.title = 'Add friend';

  // Don't show anything next to our own name
  if (playerName === myName) return;

  // Guests can't add friends and can't be added as friends
  if (!currentUser || !db) return;
  if (currentUser.isAnonymous) return;

  try {
    const oppUid = getOnlinePlayerUidForDisplayColor(color);
    if (!oppUid || oppUid === currentUser.uid) return;
    if (await isGuestPlayer(oppUid, playerName)) return;

    if (hasPendingInGameFriendRequest(oppUid)) {
      addBtn.disabled = true;
      addBtn.title = `Friend request sent to ${playerName}`;
      addBtn.classList.add('request-sent');
      addBtn.style.display = 'inline-flex';
      return;
    }

    const friendSnap = await db.ref(`users/${currentUser.uid}/friends/${oppUid}`).once('value');
    if (friendSnap.exists()) {
      friendBtn.style.display = 'inline-flex';
    } else if (hasAcceptedInGameFriendship(oppUid) && !hasRemovedInGameFriendship(oppUid)) {
      friendBtn.style.display = 'inline-flex';
    } else {
      addBtn.disabled = false;
      addBtn.title = `Add ${playerName}`;
      addBtn.style.display = 'inline-flex';
    }
  } catch (_) {
    // fail silently
  }
}

async function isGuestPlayer(uid, displayName = '') {
  if (!uid) return false;
  if (String(displayName || '').toLowerCase().startsWith('guest_')) return true;
  try {
    const guestSnap = await db.ref(`users/${uid}/isGuest`).once('value');
    return guestSnap.val() === true;
  } catch (_) {
    return false;
  }
}

function getOnlinePlayerUidForDisplayColor(color) {
  return color === 'White' ? onlinePlayerUidByColor.w : onlinePlayerUidByColor.b;
}

function hasPendingInGameFriendRequest(targetUid) {
  const request = currentGameFriendRequests?.[currentUser?.uid];
  return !!request && request.toUid === targetUid;
}

function hasAcceptedInGameFriendship(targetUid) {
  const acceptedByMe = currentGameFriendAccepts?.[currentUser?.uid];
  const acceptedByThem = currentGameFriendAccepts?.[targetUid];
  return acceptedByMe?.toUid === targetUid || acceptedByThem?.toUid === currentUser?.uid;
}

function hasRemovedInGameFriendship(targetUid) {
  const removedByMe = currentGameFriendRemovals?.[currentUser?.uid];
  const removedByThem = currentGameFriendRemovals?.[targetUid];
  return removedByMe?.toUid === targetUid || removedByThem?.toUid === currentUser?.uid;
}

async function addFriendFromPlayerSlot(color) {
  if (!currentUser) { openAuthModal('signup'); return; }
  if (!db || !friendGameRef) return;

  const targetUid = getOnlinePlayerUidForDisplayColor(color);
  const nameEl = document.getElementById(`info${color}Player`);
  const targetName = nameEl?.textContent || 'opponent';
  const addBtn = document.getElementById(`addFriend${color}`);
  const friendBtn = document.getElementById(`alreadyFriend${color}`);

  if (!targetUid || targetUid === currentUser.uid) return;
  if (currentUser.isAnonymous || await isGuestPlayer(targetUid, targetName)) {
    if (addBtn) addBtn.style.display = 'none';
    if (friendBtn) friendBtn.style.display = 'none';
    return;
  }

  try {
    const alreadySnap = await db.ref(`users/${currentUser.uid}/friends/${targetUid}`).once('value');
    if (alreadySnap.exists()) {
      if (addBtn) addBtn.style.display = 'none';
      if (friendBtn) friendBtn.style.display = 'inline-flex';
      openFriendsModal();
      return;
    }

    if (addBtn) {
      addBtn.disabled = true;
      addBtn.title = 'Sending request...';
    }

    const requestUpdates = {};
    requestUpdates[`friendRequests/${currentUser.uid}`] = {
      toUid: targetUid,
      fromUsername: sanitizePlayerName(currentUsername),
      toUsername: sanitizePlayerName(targetName),
      sentAt: firebase.database.ServerValue.TIMESTAMP
    };
    requestUpdates[`friendRemovals/${currentUser.uid}`] = null;
    requestUpdates[`friendRemovals/${targetUid}`] = null;
    await friendGameRef.update(requestUpdates);

    if (addBtn) {
      addBtn.title = `Friend request sent to ${targetName}`;
      addBtn.classList.add('request-sent');
    }
  } catch (err) {
    console.error('In-game friend request failed:', err);
    if (addBtn) {
      addBtn.disabled = false;
      addBtn.title = 'Add friend';
    }
    alert('Unable to send friend request right now.');
  }
}

/* ══════════════════════════════════════════
   TIMER SYSTEM
══════════════════════════════════════════ */
function startTimers() {
  if (timerLimitSecs === 0) return; // no limit mode
  if (timersRunning) return;
  timersRunning = true;
  timerInterval = setInterval(() => {
    if (gameOver) { stopTimers(); return; }
    if (currentTurn === 'w') timerWhiteSecs--;
    else                     timerBlackSecs--;

    if (timerWhiteSecs <= 0) {
      timerWhiteSecs = 0;
      updateTimerDisplays();
      triggerGameOver('timeout', '', 'White');
      return;
    }
    if (timerBlackSecs <= 0) {
      timerBlackSecs = 0;
      updateTimerDisplays();
      triggerGameOver('timeout', '', 'Black');
      return;
    }

    updateTimerDisplays();
  }, 1000);
  updateTimerActiveState();
}

function canEditTimerSettings() {
  return gameMode !== 'friend';
}

function stopTimers() {
  timersRunning = false;
  clearInterval(timerInterval);
  timerInterval = null;
}

function resetTimers(force = false) {
  if (!force && !canEditTimerSettings()) return;
  stopTimers();
  timerWhiteSecs = timerLimitSecs;
  timerBlackSecs = timerLimitSecs;
  updateTimerDisplays();
  updateTimerActiveState();
}

function changeTimerPreset() {
  if (!canEditTimerSettings()) return;
  const val = parseInt(document.getElementById('timerPreset').value);
  timerLimitSecs = val;
  resetTimers();
}

function updateTimerControls() {
  const controls = document.getElementById('timerControls');
  const startBtn = document.getElementById('timerStartBtn');
  const resetBtn = document.getElementById('timerResetBtn');
  const preset   = document.getElementById('timerPreset');
  const editable = canEditTimerSettings();

  document.body?.classList.toggle('online-timer-locked', !editable);
  if (controls) {
    controls.hidden = !editable;
    controls.style.display = editable ? 'flex' : 'none';
  }
  if (startBtn) startBtn.disabled = !editable;
  if (resetBtn) resetBtn.disabled = !editable;
  if (preset) {
    preset.disabled = !editable;
    if (editable) preset.value = String(timerLimitSecs);
  }
}

function updateTimerDisplays() {
  document.getElementById('timerWhiteVal').textContent = formatTime(timerWhiteSecs);
  document.getElementById('timerBlackVal').textContent = formatTime(timerBlackSecs);

  // Low time warning (< 30 sec)
  document.getElementById('timerWhite').classList.toggle('low-time', timerLimitSecs > 0 && timerWhiteSecs < 30);
  document.getElementById('timerBlack').classList.toggle('low-time', timerLimitSecs > 0 && timerBlackSecs < 30);
}

function updateTimerActiveState() {
  document.getElementById('timerWhite').classList.toggle('active', timersRunning && currentTurn === 'w');
  document.getElementById('timerBlack').classList.toggle('active', timersRunning && currentTurn === 'b');
  updateTimerControls();
}

function formatTime(secs) {
  if (secs <= 0 || !isFinite(secs)) return '0:00';
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/* ══════════════════════════════════════════
   GAME MODE
══════════════════════════════════════════ */
function setGameMode(mode) {
  if (mode === 'friend') {
    openPlayOnlineModal();
    return;
  }
  
  if (gameMode === 'friend') {
    exitFriendGame();
  }
  
  gameMode = mode;
  showGamePage();
  updatePrimaryNavState(mode);
  updateGameInfo();
  newGame();
}

function dismissAIBanner() {
  document.getElementById('aiBanner').style.display = 'none';
  setGameMode('pvp');
}

/* ══════════════════════════════════════════
   MODAL HELPERS
══════════════════════════════════════════ */
function closeModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.style.display = 'none';
  // If the Play Online modal is closed while matchmaking, cancel the search
  if (id === 'friendModal' && matchmakingListener) {
    cancelMatchmaking();
  }
}

/* ══════════════════════════════════════════
   SOUND EFFECTS (Web Audio API)
══════════════════════════════════════════ */
let audioCtx = null;

function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function playSound(type) {
  if ((type === 'move' || type === 'promote') && !userSettings.moveSounds) return;
  if ((type === 'capture' || type === 'check' || type === 'checkmate') && !userSettings.alertSounds) return;

  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0.08, now);

    switch (type) {
      case 'move':
        osc.frequency.setValueAtTime(520, now);
        osc.frequency.exponentialRampToValueAtTime(480, now + 0.08);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
        osc.start(now); osc.stop(now + 0.12);
        break;
      case 'capture':
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(280, now);
        osc.frequency.exponentialRampToValueAtTime(180, now + 0.18);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
        osc.start(now); osc.stop(now + 0.2);
        break;
      case 'check':
        osc.frequency.setValueAtTime(660, now);
        osc.frequency.setValueAtTime(740, now + 0.06);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
        osc.start(now); osc.stop(now + 0.22);
        break;
      case 'checkmate':
        [0, 0.18, 0.36].forEach((t, i) => {
          const o2 = ctx.createOscillator();
          const g2 = ctx.createGain();
          o2.connect(g2); g2.connect(ctx.destination);
          o2.frequency.setValueAtTime([440, 370, 330][i], now + t);
          g2.gain.setValueAtTime(0.1, now + t);
          g2.gain.exponentialRampToValueAtTime(0.001, now + t + 0.28);
          o2.start(now + t); o2.stop(now + t + 0.3);
        });
        return;
      case 'promote':
        [0, 0.1].forEach((t, i) => {
          const o2 = ctx.createOscillator();
          const g2 = ctx.createGain();
          o2.connect(g2); g2.connect(ctx.destination);
          o2.frequency.setValueAtTime([600, 800][i], now + t);
          g2.gain.setValueAtTime(0.09, now + t);
          g2.gain.exponentialRampToValueAtTime(0.001, now + t + 0.15);
          o2.start(now + t); o2.stop(now + t + 0.18);
        });
        return;
    }
  } catch (_) {
    // Audio not available — fail silently
  }
}

/* ══════════════════════════════════════════
   USER SETTINGS
   Stored locally so preferences survive refresh without touching Firebase.
══════════════════════════════════════════ */
const BOARD_THEMES = {
  classic: {
    '--sq-light': '#f0d9b5',
    '--sq-dark': '#b58863',
    '--sq-light-hl': '#cdd26a',
    '--sq-dark-hl': '#aaa23b',
    '--sq-selected': '#7fc97f'
  },
  green: {
    '--sq-light': '#d6e8c7',
    '--sq-dark': '#6b9b58',
    '--sq-light-hl': '#c7dc67',
    '--sq-dark-hl': '#82aa43',
    '--sq-selected': '#5db370'
  },
  blue: {
    '--sq-light': '#d8e6f3',
    '--sq-dark': '#5f7fa3',
    '--sq-light-hl': '#b9d46a',
    '--sq-dark-hl': '#6f9a49',
    '--sq-selected': '#73a8d8'
  },
  purple: {
    '--sq-light': '#eadcf4',
    '--sq-dark': '#8261a6',
    '--sq-light-hl': '#d3cc68',
    '--sq-dark-hl': '#9a9140',
    '--sq-selected': '#a77bd1'
  },
  contrast: {
    '--sq-light': '#f8f8f8',
    '--sq-dark': '#202020',
    '--sq-light-hl': '#ffef65',
    '--sq-dark-hl': '#b6a800',
    '--sq-selected': '#00c853'
  }
};

function loadUserSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || '{}');
    userSettings = normalizeUserSettings({ ...DEFAULT_USER_SETTINGS, ...stored });
  } catch (_) {
    userSettings = { ...DEFAULT_USER_SETTINGS };
  }
  if (gameMode !== 'friend') {
    timerLimitSecs = userSettings.defaultTimer;
    timerWhiteSecs = timerLimitSecs;
    timerBlackSecs = timerLimitSecs;
  }
  applyUserSettings(false);
}

function normalizeUserSettings(settings) {
  const timer = Number(settings.defaultTimer);
  return {
    ...DEFAULT_USER_SETTINGS,
    ...settings,
    boardTheme: BOARD_THEMES[settings.boardTheme] ? settings.boardTheme : DEFAULT_USER_SETTINGS.boardTheme,
    pieceStyle: 'unicode',
    defaultTimer: [0, 60, 180, 300, 600].includes(timer) ? timer : DEFAULT_USER_SETTINGS.defaultTimer,
    moveSounds: settings.moveSounds !== false,
    alertSounds: settings.alertSounds !== false,
    legalHighlights: settings.legalHighlights !== false,
    lastMoveHighlight: settings.lastMoveHighlight !== false,
    coordinates: settings.coordinates !== false,
    autoFlipBlack: settings.autoFlipBlack !== false,
    compactMode: settings.compactMode === true
  };
}

function saveUserSettings() {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(userSettings));
}

function applyUserSettings(shouldRender = true) {
  const theme = BOARD_THEMES[userSettings.boardTheme] || BOARD_THEMES.classic;
  Object.entries(theme).forEach(([name, value]) => {
    document.documentElement.style.setProperty(name, value);
  });

  document.body?.classList.toggle('hide-legal-moves', !userSettings.legalHighlights);
  document.body?.classList.toggle('hide-last-move', !userSettings.lastMoveHighlight);
  document.body?.classList.toggle('hide-coordinates', !userSettings.coordinates);
  document.body?.classList.toggle('compact-mode', userSettings.compactMode);

  const timerPreset = document.getElementById('timerPreset');
  if (timerPreset && gameMode !== 'friend') timerPreset.value = String(userSettings.defaultTimer);

  syncSettingsControls();
  if (shouldRender) {
    renderCoords();
    renderBoard();
    updateTimerControls();
  }
}

function syncSettingsControls() {
  document.querySelectorAll('.theme-choice').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === userSettings.boardTheme);
  });

  setChecked('settingMoveSounds', userSettings.moveSounds);
  setChecked('settingAlertSounds', userSettings.alertSounds);
  setChecked('settingLegalHighlights', userSettings.legalHighlights);
  setChecked('settingLastMoveHighlight', userSettings.lastMoveHighlight);
  setChecked('settingCoordinates', userSettings.coordinates);
  setChecked('settingAutoFlipBlack', userSettings.autoFlipBlack);
  setChecked('settingCompactMode', userSettings.compactMode);

  const defaultTimer = document.getElementById('settingDefaultTimer');
  if (defaultTimer) defaultTimer.value = String(userSettings.defaultTimer);
}

function setChecked(id, value) {
  const el = document.getElementById(id);
  if (el) el.checked = !!value;
}

function openSettingsModal() {
  const dropdown = document.getElementById('profileDropdown');
  if (dropdown) dropdown.style.display = 'none';
  syncSettingsControls();
  document.getElementById('settingsModal').style.display = 'flex';
}

function setBoardTheme(theme) {
  userSettings.boardTheme = BOARD_THEMES[theme] ? theme : 'classic';
  saveUserSettings();
  applyUserSettings();
}

function updateSettingFromInput(key, value) {
  if (!(key in DEFAULT_USER_SETTINGS)) return;
  userSettings[key] = key === 'defaultTimer' ? Number(value) : value;
  userSettings = normalizeUserSettings(userSettings);
  if (key === 'defaultTimer' && gameMode !== 'friend') {
    timerLimitSecs = userSettings.defaultTimer;
    resetTimers(true);
  }
  saveUserSettings();
  applyUserSettings();
}

function resetUserSettings() {
  userSettings = { ...DEFAULT_USER_SETTINGS };
  if (gameMode !== 'friend') {
    timerLimitSecs = userSettings.defaultTimer;
    resetTimers(true);
  }
  saveUserSettings();
  applyUserSettings();
}

/* ══════════════════════════════════════════
   HELPER UTILITIES
══════════════════════════════════════════ */
function getPieceColor(piece) { return piece ? piece[0] : null; }
function getPieceType(piece)  { return piece ? piece[1] : null; }

/**
 * Generate FEN string (for future Stockfish integration)
 * Called as: generateFEN()
 */
function generateFEN() {
  let fen = '';
  for (let r = 0; r < 8; r++) {
    let empty = 0;
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (!p) { empty++; }
      else {
        if (empty) { fen += empty; empty = 0; }
        const type  = getPieceType(p);
        const color = getPieceColor(p);
        fen += color === 'w' ? type : type.toLowerCase();
      }
    }
    if (empty) fen += empty;
    if (r < 7) fen += '/';
  }
  fen += ' ' + currentTurn;

  // Castling
  let castle = '';
  if (castlingRights.wK) castle += 'K';
  if (castlingRights.wQ) castle += 'Q';
  if (castlingRights.bK) castle += 'k';
  if (castlingRights.bQ) castle += 'q';
  fen += ' ' + (castle || '-');

  // En passant
  const files = 'abcdefgh';
  const ranks = '87654321';
  fen += ' ' + (enPassantSq ? files[enPassantSq.col] + ranks[enPassantSq.row] : '-');

  fen += ' 0 ' + (Math.floor(moveHistory.length / 2) + 1);
  return fen;
}

/* ══════════════════════════════════════════
   KEYBOARD SHORTCUTS
══════════════════════════════════════════ */
document.addEventListener('keydown', e => {
  if (e.key === 'z' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); undoMove(); }
  if (e.key === 'Escape') {
    closeModal('promotionModal');
    closeModal('authModal');
    selectedSq = null; legalMoves = []; renderBoard();
  }
  // Enter submits auth forms
  if (e.key === 'Enter') {
    const authModal = document.getElementById('authModal');
    if (authModal && authModal.style.display !== 'none') {
      const signUpVisible = document.getElementById('authSignUp').style.display !== 'none';
      if (signUpVisible) handleSignUp();
      else handleSignIn();
    }
    const chooseModal = document.getElementById('chooseUsernameModal');
    if (chooseModal && chooseModal.style.display !== 'none') {
      submitChosenUsername();
    }
  }
});

/* ══════════════════════════════════════════
   CLOSE MODALS ON OVERLAY CLICK
══════════════════════════════════════════ */
['gameOverModal'].forEach(id => {
  document.getElementById(id)?.addEventListener('click', function(e) {
    if (e.target === this) closeModal(id);
  });
});

/* ══════════════════════════════════════════
   AUTHENTICATION
══════════════════════════════════════════ */

function openAuthModal(defaultTab) {
  switchAuthTab(defaultTab || 'signup');
  // Reset button states
  const signUpBtn = document.getElementById('signUpBtn');
  const signInBtn = document.getElementById('signInBtn');
  if (signUpBtn) { signUpBtn.disabled = false; signUpBtn.textContent = 'Sign Up'; }
  if (signInBtn) { signInBtn.disabled = false; signInBtn.textContent = 'Sign In'; }
  document.getElementById('authModal').style.display = 'flex';
}

function openGuestSignupModal() {
  const dropdown = document.getElementById('profileDropdown');
  if (dropdown) dropdown.style.display = 'none';
  openAuthModal('signup');
}

function switchAuthTab(tab) {
  const isSignUp = tab === 'signup';
  document.getElementById('authSignUp').style.display = isSignUp ? 'block' : 'none';
  document.getElementById('authSignIn').style.display = isSignUp ? 'none' : 'block';
  document.getElementById('tabSignUp').classList.toggle('active', isSignUp);
  document.getElementById('tabSignIn').classList.toggle('active', !isSignUp);
  // Clear errors and inputs on tab switch
  document.getElementById('signUpError').style.display = 'none';
  document.getElementById('signInError').style.display = 'none';
}

function updateAccountUI(username) {
  const widget    = document.getElementById('accountWidget');
  const avatar    = document.getElementById('accountAvatar');
  const nameEl    = document.getElementById('accountUsername');
  const signInBtn = document.getElementById('btnSignIn');

  if (username) {
    const isGuest = currentUser && currentUser.isAnonymous;
    avatar.textContent  = isGuest ? '?' : username.charAt(0).toUpperCase();
    avatar.style.background = isGuest ? 'var(--text-muted)' : '';
    nameEl.textContent  = isGuest ? `${username} (Guest)` : username;
    widget.style.display    = 'flex';
    signInBtn.style.display = 'none';

    // Show/hide dropdown items based on guest status
    const friendsItem  = document.getElementById('dropdownFriends');
    const messagesItem = document.getElementById('dropdownMessages');
    const accountItem  = document.getElementById('dropdownAccount');
    const statsItem    = document.getElementById('dropdownStats');
    const guestUpgrade = document.getElementById('dropdownGuestUpgrade');
    if (friendsItem)  friendsItem.style.display  = isGuest ? 'none' : 'flex';
    if (messagesItem) messagesItem.style.display  = isGuest ? 'none' : 'flex';
    if (accountItem)  accountItem.style.display  = isGuest ? 'none' : 'flex';
    if (statsItem)    statsItem.style.display    = isGuest ? 'none' : 'flex';
    if (guestUpgrade) guestUpgrade.style.display = isGuest ? 'flex' : 'none';
  } else {
    widget.style.display    = 'none';
    signInBtn.style.display = 'inline-flex';
  }
}

async function handleSignUp() {
  const username = document.getElementById('signUpUsername').value.trim().toLowerCase();
  const password = document.getElementById('signUpPassword').value;
  const errorEl  = document.getElementById('signUpError');
  const btn      = document.getElementById('signUpBtn');

  errorEl.style.display = 'none';

  // Validate username
  if (username.length < 3) {
    showAuthError(errorEl, 'Username must be at least 3 characters.');
    return;
  }
  if (!/^[a-z0-9_]+$/.test(username)) {
    showAuthError(errorEl, 'Username can only contain letters, numbers, and underscores.');
    return;
  }
  if (password.length < 6) {
    showAuthError(errorEl, 'Password must be at least 6 characters.');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Creating account…';

  try {
    await firebase.auth().setPersistence(firebase.auth.Auth.Persistence.LOCAL);
    // Create Firebase Auth account using username@digichess.com as internal email
    // Auth enforces uniqueness, so this works even before database rules allow user reads.
    const email = `${username}@digichess.com`;
    const cred  = await firebase.auth().createUserWithEmailAndPassword(email, password);
    const uid   = cred.user.uid;

    // Store username in DB (both for lookup and reverse lookup)
    await db.ref(`users/${uid}/username`).set(username);
    await db.ref(`usernames/${username}`).set(uid);
    await ensureUserElo(username, uid);

    // Close modal — onAuthStateChanged will update the UI
    closeModal('authModal');

  } catch (err) {
    console.error('Sign up error:', err);
    showAuthError(errorEl, friendlyAuthError(err.code));
    btn.disabled = false;
    btn.textContent = 'Sign Up';
  }
}

async function handleSignIn() {
  const username = document.getElementById('signInUsername').value.trim().toLowerCase();
  const password = document.getElementById('signInPassword').value;
  const errorEl  = document.getElementById('signInError');
  const btn      = document.getElementById('signInBtn');

  errorEl.style.display = 'none';

  if (!username || !password) {
    showAuthError(errorEl, 'Please enter your username and password.');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Signing in…';

  try {
    await firebase.auth().setPersistence(firebase.auth.Auth.Persistence.LOCAL);
    const email = `${username}@digichess.com`;
    await firebase.auth().signInWithEmailAndPassword(email, password);
    closeModal('authModal');
  } catch (err) {
    console.error('Sign in error:', err);
    showAuthError(errorEl, friendlyAuthError(err.code));
    btn.disabled = false;
    btn.textContent = 'Sign In';
  }
}

async function signInWithGoogle() {
  try {
    await firebase.auth().setPersistence(firebase.auth.Auth.Persistence.LOCAL);
    const provider = new firebase.auth.GoogleAuthProvider();
    const cred     = await firebase.auth().signInWithPopup(provider);
    const user     = cred.user;
    const uid      = user.uid;

    // Check if this Google user already has a username stored
    const snap = await db.ref(`users/${uid}/username`).once('value');
    if (!snap.exists()) {
      // No username yet — close auth modal and prompt them to choose one
      closeModal('authModal');
      openChooseUsernameModal(uid);
    } else {
      closeModal('authModal');
    }
  } catch (err) {
    if (err.code !== 'auth/popup-closed-by-user' && err.code !== 'auth/cancelled-popup-request') {
      console.error('Google sign-in error:', err);
      alert('Google sign-in failed. Please try again.');
    }
  }
}

function openChooseUsernameModal(uid) {
  document.getElementById('chooseUsernameModal').style.display = 'flex';
  document.getElementById('chooseUsernameInput').value = '';
  document.getElementById('chooseUsernameError').style.display = 'none';
  // Store uid on the modal for use when submitting
  document.getElementById('chooseUsernameModal').dataset.uid = uid;
}

async function submitChosenUsername() {
  const modal    = document.getElementById('chooseUsernameModal');
  const uid      = modal.dataset.uid || (currentUser && currentUser.uid);
  const username = document.getElementById('chooseUsernameInput').value.trim().toLowerCase();
  const errorEl  = document.getElementById('chooseUsernameError');
  const btn      = document.getElementById('chooseUsernameBtn');

  errorEl.style.display = 'none';

  if (username.length < 3) {
    return showAuthError(errorEl, 'Username must be at least 3 characters.');
  }
  if (!/^[a-z0-9_]+$/.test(username)) {
    return showAuthError(errorEl, 'Only letters, numbers, and underscores allowed.');
  }

  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    const taken = await db.ref(`usernames/${username}`).once('value');
    if (taken.exists()) {
      showAuthError(errorEl, 'That username is already taken. Try another.');
      btn.disabled = false; btn.textContent = 'Save Username';
      return;
    }

    await db.ref(`users/${uid}/username`).set(username);
    await db.ref(`usernames/${username}`).set(uid);
    await ensureUserElo(username, uid);

    currentUsername = username;
    updateAccountUI(username);
    closeModal('chooseUsernameModal');
  } catch (err) {
    console.error('Choose username error:', err);
    showAuthError(errorEl, 'Something went wrong. Please try again.');
    btn.disabled = false; btn.textContent = 'Save Username';
  }
}

async function continueAsGuest() {
  try {
    await firebase.auth().setPersistence(firebase.auth.Auth.Persistence.SESSION);
    // Sign in anonymously — Firebase creates a temporary account
    const cred = await firebase.auth().signInAnonymously();
    const uid  = cred.user.uid;

    // Generate a guest display name
    const guestName = 'Guest_' + Math.random().toString(36).substr(2, 5).toUpperCase();
    currentUsername = guestName;

    // Store temporarily in DB so game rooms can reference it
    await db.ref(`users/${uid}/username`).set(guestName);
    await db.ref(`users/${uid}/isGuest`).set(true);
    registerGuestCleanup(uid);

    closeModal('authModal');

    // Register cleanup on tab/window close
    window.addEventListener('beforeunload', deleteGuestAccount);
    window.addEventListener('pagehide', deleteGuestAccount);
  } catch (err) {
    console.error('Guest sign in error:', err);
  }
}

function registerGuestCleanup(uid) {
  if (!db || !uid) return;
  db.ref('.info/connected').on('value', snap => {
    if (!snap.val()) return;
    db.ref(`users/${uid}`).onDisconnect().remove();
    db.ref(`matchmaking/${uid}`).onDisconnect().remove();
  });
}

async function deleteGuestAccount() {
  if (!currentUser || !currentUser.isAnonymous) return;
  try {
    const uid = currentUser.uid;
    // Remove DB data
    await db.ref(`users/${uid}`).remove();
    // Delete the Firebase Auth account
    await currentUser.delete();
  } catch (err) {
    // Best-effort — may fail if connection drops during unload
    console.error('Guest cleanup error:', err);
  }
}

function signOutUser() {
  if (currentUser && currentUser.isAnonymous) {
    deleteGuestAccount().catch(err => console.error('Guest sign out cleanup error:', err));
    return;
  }
  firebase.auth().signOut().catch(err => console.error('Sign out error:', err));
}

/* ══════════════════════════════════════════
   ACCOUNT SETTINGS
══════════════════════════════════════════ */

function openAccountModal() {
  document.getElementById('profileDropdown').style.display = 'none';
  // Reset all fields and messages
  ['newUsernameInput','newPasswordInput']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  ['changeUsernameError','changeUsernameSuccess','changePasswordError','changePasswordSuccess','deleteAccountError']
    .forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
  ['changeUsernameBtn','changePasswordBtn','deleteAccountBtn']
    .forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.disabled = false;
        el.textContent = { changeUsernameBtn:'Update Username', changePasswordBtn:'Update Password', deleteAccountBtn:'Delete Account' }[id];
      }
    });

  const sub = document.getElementById('accountModalSub');
  if (sub) sub.textContent = `Signed in as: ${currentUsername}`;

  document.getElementById('accountModal').style.display = 'flex';
}

async function openStatsModal() {
  const dropdown = document.getElementById('profileDropdown');
  if (dropdown) dropdown.style.display = 'none';
  if (!currentUser || currentUser.isAnonymous) return;

  document.getElementById('statsModal').style.display = 'flex';
  await loadStatsModal(currentUser.uid, currentUsername || 'Player', true);
}

async function openFriendStatsModal(friendUid, friendName) {
  if (!currentUser || !db) return;
  closeModal('friendsModal');
  document.getElementById('statsModal').style.display = 'flex';
  await loadStatsModal(friendUid, friendName || 'Player', false);
}

function emptyStats() {
  return {
    elo: STARTING_ELO,
    onlineMatches: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    rankedMatches: 0,
    rankedWins: 0,
    rankedLosses: 0,
    rankedDraws: 0,
    unrankedMatches: 0,
    checkmateWins: 0,
    timeoutWins: 0,
    resignWins: 0,
    currentFriends: 0,
    friendsMadeInMatches: 0
  };
}

function normalizeElo(value) {
  const elo = Number(value);
  return Number.isFinite(elo) ? Math.max(MIN_ELO, Math.round(elo)) : STARTING_ELO;
}

async function ensureUserElo(username = currentUsername, uid = currentUser?.uid) {
  if (!uid || !db) return STARTING_ELO;
  if (currentUser?.uid === uid && currentUser.isAnonymous) return null;

  let latestElo = STARTING_ELO;
  await db.ref(`users/${uid}/stats`).transaction(current => {
    const stats = { ...emptyStats(), ...(current || {}) };
    stats.elo = normalizeElo(stats.elo);
    latestElo = stats.elo;
    return stats;
  });

  if (uid === currentUser?.uid && !currentUser.isAnonymous) {
    publishLeaderboardStats({ ...(await getOwnStats()), elo: latestElo }, username).catch(err => {
      console.warn('Unable to publish Elo leaderboard stats:', err);
    });
  }
  return latestElo;
}

async function getOwnStats() {
  if (!currentUser || currentUser.isAnonymous || !db) return emptyStats();
  const snap = await db.ref(`users/${currentUser.uid}/stats`).once('value');
  return { ...emptyStats(), ...(snap.val() || {}) };
}

function calculateEloChange(playerElo, opponentElo, actualScore) {
  const expected = 1 / (1 + Math.pow(10, (normalizeElo(opponentElo) - normalizeElo(playerElo)) / 400));
  const next = normalizeElo(playerElo + ELO_K_FACTOR * (actualScore - expected));
  return {
    oldElo: normalizeElo(playerElo),
    newElo: next,
    change: next - normalizeElo(playerElo)
  };
}

function scoreForRankedResult(gameData, myDisplayColor) {
  if (gameData.gameOverReason === 'agreedDraw') return null;
  if (gameData.gameOverReason === 'stalemate') return 0.5;
  return gameData.gameOverWinner === myDisplayColor ? 1 : 0;
}

async function applyRankedEloChange(gameData, gameKey) {
  if (!currentUser || currentUser.isAnonymous || !db || !gameData?.ranked) return;
  if (!gameData.players?.host || !gameData.players?.joiner || !myColor) return;
  if (recordedEloGames.has(gameKey)) return;
  recordedEloGames.add(gameKey);

  const markerRef = db.ref(`users/${currentUser.uid}/eloRecordedGames/${gameKey}`);
  const claim = await markerRef.transaction(current => current ? undefined : true);
  if (!claim.committed) return;

  const colors = gameData.colors || {};
  const opponentUid = Object.keys(colors).find(uid => uid !== currentUser.uid && (colors[uid] === 'w' || colors[uid] === 'b'));
  if (!opponentUid) return;

  const playerElos = gameData.playerElos || {};
  const myDisplayColor = myColor === 'w' ? 'White' : 'Black';
  const actualScore = scoreForRankedResult(gameData, myDisplayColor);
  if (actualScore === null) return;
  const opponentElo = normalizeElo(playerElos[opponentUid]);

  await db.ref(`users/${currentUser.uid}/stats`).transaction(current => {
    const stats = { ...emptyStats(), ...(current || {}) };
    const eloResult = calculateEloChange(stats.elo, opponentElo, actualScore);
    stats.elo = eloResult.newElo;
    stats.rankedMatches = (Number(stats.rankedMatches) || 0) + 1;
    if (actualScore === 1) stats.rankedWins = (Number(stats.rankedWins) || 0) + 1;
    else if (actualScore === 0) stats.rankedLosses = (Number(stats.rankedLosses) || 0) + 1;
    else stats.rankedDraws = (Number(stats.rankedDraws) || 0) + 1;
    return stats;
  }).then(result => {
    if (result.committed) {
      publishLeaderboardStats({ ...emptyStats(), ...(result.snapshot.val() || {}) }).catch(err => {
        console.warn('Unable to publish Elo leaderboard update:', err);
      });
    }
  });
}

async function loadStatsModal(uid = currentUser?.uid, displayName = currentUsername || 'Player', publishOwn = false) {
  if (!uid || !db) return;
  const sub = document.getElementById('statsModalSub');
  if (sub) sub.textContent = `Stats for ${sanitizePlayerName(displayName, 'Player')}`;

  const statsSnap = await db.ref(`users/${uid}/stats`).once('value');
  const stats = { ...emptyStats(), ...(statsSnap.val() || {}) };
  if (publishOwn) publishLeaderboardStats(stats).catch(err => console.warn('Unable to publish leaderboard stats:', err));
  let currentFriends = Number(stats.currentFriends) || 0;
  if (uid === currentUser?.uid) {
    try {
      const friendsSnap = await db.ref(`users/${uid}/friends`).once('value');
      currentFriends = Object.keys(friendsSnap.val() || {}).length;
      stats.currentFriends = currentFriends;
      await syncOwnFriendCountStat(currentFriends);
    } catch (_) {}
  }
  const decisiveGames = stats.wins + stats.losses;
  const winRate = decisiveGames > 0 ? Math.round((stats.wins / decisiveGames) * 100) : 0;
  const avgFriends = stats.onlineMatches > 0 ? (stats.friendsMadeInMatches / stats.onlineMatches).toFixed(2) : '0.00';

  setText('statWins', stats.wins);
  setText('statLosses', stats.losses);
  setText('statWinRate', `${winRate}%`);
  setText('statDraws', stats.draws);
  setText('statElo', normalizeElo(stats.elo));
  setText('statMatches', stats.onlineMatches);
  setText('statRankedMatches', stats.rankedMatches);
  setText('statRankedWins', stats.rankedWins);
  setText('statRankedLosses', stats.rankedLosses);
  setText('statRankedDraws', stats.rankedDraws);
  setText('statUnrankedMatches', stats.unrankedMatches);
  setText('statCheckmateWins', stats.checkmateWins);
  setText('statTimeoutWins', stats.timeoutWins);
  setText('statResignWins', stats.resignWins);
  setText('statCurrentFriends', currentFriends);
  setText('statFriendsMade', stats.friendsMadeInMatches);
  setText('statAvgFriends', avgFriends);
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function safeDbKey(value) {
  return String(value).replace(/[.#$/\[\]]/g, '_');
}

async function incrementUserStats(delta, recordPath = null) {
  if (!currentUser || currentUser.isAnonymous || !db) return;

  if (recordPath) {
    const markerRef = db.ref(`users/${currentUser.uid}/${recordPath}`);
    const claim = await markerRef.transaction(current => current ? undefined : true);
    if (!claim.committed) return;
  }

  await db.ref(`users/${currentUser.uid}/stats`).transaction(current => {
    const stats = { ...emptyStats(), ...(current || {}) };
    Object.entries(delta).forEach(([key, amount]) => {
      stats[key] = (Number(stats[key]) || 0) + amount;
      if (key === 'currentFriends') stats[key] = Math.max(0, stats[key]);
    });
    return stats;
  }).then(result => {
    if (result.committed) {
      publishLeaderboardStats().catch(err => {
        console.warn('Unable to publish leaderboard stats:', err);
      });
    }
  });
}

async function syncOwnFriendCountStat(friendCount) {
  if (!currentUser || currentUser.isAnonymous || !db) return;
  await db.ref(`users/${currentUser.uid}/stats/currentFriends`).set(Math.max(0, Number(friendCount) || 0));
}

async function adjustOwnFriendCountStat(delta) {
  if (!currentUser || currentUser.isAnonymous || !db) return;
  await incrementUserStats({ currentFriends: delta });
}

async function publishLeaderboardStats(stats = null, usernameOverride = currentUsername) {
  if (!currentUser || currentUser.isAnonymous || !db) return;
  const sourceStats = stats || { ...emptyStats(), ...((await db.ref(`users/${currentUser.uid}/stats`).once('value')).val() || {}) };
  const decisiveGames = (Number(sourceStats.wins) || 0) + (Number(sourceStats.losses) || 0);
  const winRate = decisiveGames > 0 ? Math.round(((Number(sourceStats.wins) || 0) / decisiveGames) * 10000) / 100 : 0;

  await db.ref(`leaderboards/${currentUser.uid}`).set({
    username: sanitizePlayerName(usernameOverride),
    elo: normalizeElo(sourceStats.elo),
    wins: Number(sourceStats.wins) || 0,
    losses: Number(sourceStats.losses) || 0,
    winRate,
    onlineMatches: Number(sourceStats.onlineMatches) || 0,
    updatedAt: firebase.database.ServerValue.TIMESTAMP
  });
}

function recordOnlineGameStatsIfNeeded(gameData) {
  if (!currentUser || currentUser.isAnonymous || !gameData?.gameOver || !gameData.gameOverReason) return;
  if (gameData.gameOverReason === 'agreedDraw') return;
  if (gameMode !== 'friend') return;
  if (!friendJoinCode || !myColor) return;
  const players = gameData.players || {};
  if (players.host !== currentUser.uid && players.joiner !== currentUser.uid) return;
  if (!players.host || !players.joiner) return;

  const gameKey = safeDbKey(`${friendJoinCode}_${gameData.createdAt || 'game'}_${gameData.gameOverReason}`);
  if (recordedGameStats.has(gameKey)) return;
  recordedGameStats.add(gameKey);

  const myDisplayColor = myColor === 'w' ? 'White' : 'Black';
  const reason = gameData.gameOverReason;
  const delta = { onlineMatches: 1 };
  if (!gameData.ranked) delta.unrankedMatches = 1;

  if (reason === 'stalemate') {
    delta.draws = 1;
  } else if (gameData.gameOverWinner === myDisplayColor) {
    delta.wins = 1;
    if (reason === 'checkmate') delta.checkmateWins = 1;
    if (reason === 'timeout') delta.timeoutWins = 1;
    if (reason === 'resign') delta.resignWins = 1;
  } else {
    delta.losses = 1;
  }

  incrementUserStats(delta, `statsRecordedGames/${gameKey}`).catch(err => {
    recordedGameStats.delete(gameKey);
    console.error('Failed to record game stats:', err);
  });

  if (gameData.ranked) {
    applyRankedEloChange(gameData, gameKey).catch(err => {
      recordedEloGames.delete(gameKey);
      console.error('Failed to apply ranked Elo:', err);
    });
  }
}

function recordFriendMadeInMatch(friendUid) {
  if (!currentUser || currentUser.isAnonymous || !friendJoinCode || !friendUid) return;
  const recordKey = safeDbKey(`${friendJoinCode}_${friendUid}`);
  if (recordedFriendStats.has(recordKey)) return;
  recordedFriendStats.add(recordKey);
  incrementUserStats({ friendsMadeInMatches: 1 }, `statsRecordedFriends/${recordKey}`).catch(err => {
    recordedFriendStats.delete(recordKey);
    console.error('Failed to record friend stats:', err);
  });
}

async function handleChangeUsername() {
  const newUsername = document.getElementById('newUsernameInput').value.trim().toLowerCase();
  const errorEl     = document.getElementById('changeUsernameError');
  const successEl   = document.getElementById('changeUsernameSuccess');
  const btn         = document.getElementById('changeUsernameBtn');

  errorEl.style.display = successEl.style.display = 'none';

  if (newUsername.length < 3) return showAuthError(errorEl, 'Username must be at least 3 characters.');
  if (!/^[a-z0-9_]+$/.test(newUsername)) return showAuthError(errorEl, 'Only letters, numbers, and underscores allowed.');
  if (newUsername === currentUsername) return showAuthError(errorEl, 'That is already your username.');

  btn.disabled = true; btn.textContent = 'Updating…';

  try {
    const snap = await db.ref(`usernames/${newUsername}`).once('value');
    if (snap.exists()) {
      showAuthError(errorEl, 'That username is already taken.');
      btn.disabled = false; btn.textContent = 'Update Username';
      return;
    }

    const uid         = currentUser.uid;
    const oldUsername = currentUsername;
    const updates     = {};
    updates[`usernames/${oldUsername}`] = null;
    updates[`usernames/${newUsername}`] = uid;
    updates[`users/${uid}/username`]    = newUsername;

    // Only update the internal auth email for email/password accounts
    if (!currentUser.providerData.some(p => p.providerId === 'google.com')) {
      await firebase.auth().currentUser.updateEmail(`${newUsername}@digichess.com`);
    }
    await db.ref().update(updates);

    currentUsername = newUsername;
    updateAccountUI(newUsername);
    successEl.textContent  = 'Username updated!';
    successEl.style.display = 'block';
    document.getElementById('newUsernameInput').value = '';
    document.getElementById('accountModalSub').textContent = `Signed in as: ${newUsername}`;
  } catch (err) {
    console.error('Change username error:', err);
    showAuthError(errorEl, friendlyAuthError(err.code));
  }

  btn.disabled = false; btn.textContent = 'Update Username';
}

async function handleChangePassword() {
  const newPw   = document.getElementById('newPasswordInput').value;
  const errorEl = document.getElementById('changePasswordError');
  const successEl = document.getElementById('changePasswordSuccess');
  const btn     = document.getElementById('changePasswordBtn');

  errorEl.style.display = successEl.style.display = 'none';

  if (newPw.length < 6) return showAuthError(errorEl, 'Password must be at least 6 characters.');

  if (currentUser.providerData.some(p => p.providerId === 'google.com')) {
    return showAuthError(errorEl, 'Google accounts do not use a password.');
  }

  btn.disabled = true; btn.textContent = 'Updating…';

  try {
    await firebase.auth().currentUser.updatePassword(newPw);
    successEl.textContent  = 'Password updated!';
    successEl.style.display = 'block';
    document.getElementById('newPasswordInput').value = '';
  } catch (err) {
    if (err.code === 'auth/requires-recent-login') {
      showAuthError(errorEl, 'Your session has expired. Please sign out and sign back in, then try again.');
    } else {
      showAuthError(errorEl, friendlyAuthError(err.code));
    }
    console.error('Change password error:', err);
  }

  btn.disabled = false; btn.textContent = 'Update Password';
}

async function handleDeleteAccount() {
  const errorEl = document.getElementById('deleteAccountError');
  const btn     = document.getElementById('deleteAccountBtn');
  errorEl.style.display = 'none';

  if (!confirm(`Delete your account "${currentUsername}"?\n\nAll your data will be permanently lost. This cannot be undone.`)) return;

  btn.disabled = true; btn.textContent = 'Deleting…';

  try {
    const uid = currentUser.uid;
    const updates = {};
    updates[`users/${uid}`]                = null;
    updates[`usernames/${currentUsername}`] = null;
    await db.ref().update(updates);
    await firebase.auth().currentUser.delete();
    closeModal('accountModal');
  } catch (err) {
    if (err.code === 'auth/requires-recent-login') {
      showAuthError(errorEl, 'Your session has expired. Please sign out and sign back in, then try again.');
    } else {
      showAuthError(errorEl, friendlyAuthError(err.code));
    }
    console.error('Delete account error:', err);
    btn.disabled = false; btn.textContent = 'Delete Account';
  }
}

function showAuthError(el, message) {
  el.textContent     = message;
  el.style.display   = 'block';
}

function friendlyAuthError(code) {
  switch (code) {
    case 'auth/wrong-password':
    case 'auth/user-not-found':
    case 'auth/invalid-credential':
      return 'Incorrect username or password.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Please wait a moment and try again.';
    case 'auth/weak-password':
      return 'Password must be at least 6 characters.';
    case 'auth/email-already-in-use':
      return 'That username is already taken. Try another.';
    case 'PERMISSION_DENIED':
    case 'permission_denied':
      return 'Account setup is blocked by database permissions. Please try again after the latest rules are deployed.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

/* ══════════════════════════════════════════
   FRIENDS SYSTEM
══════════════════════════════════════════ */

function openProfileDropdown() {
  const dropdown = document.getElementById('profileDropdown');
  if (!dropdown) return;
  const isOpen = dropdown.style.display === 'block';
  dropdown.style.display = isOpen ? 'none' : 'block';
}

// Close dropdown if clicking outside
document.addEventListener('click', e => {
  const widget = document.getElementById('accountWidget');
  const dropdown = document.getElementById('profileDropdown');
  if (dropdown && widget && !widget.contains(e.target)) {
    dropdown.style.display = 'none';
  }
});

function openFriendsModal() {
  const dropdown = document.getElementById('profileDropdown');
  if (dropdown) dropdown.style.display = 'none';
  document.getElementById('friendsModal').style.display = 'flex';
  loadFriendsModal();
}

async function loadFriendsModal() {
  if (!currentUser || !db) return;
  const uid = currentUser.uid;

  // Load friends list
  const friendsSnap = await db.ref(`users/${uid}/friends`).once('value');
  const friends = friendsSnap.val() || {};
  const friendsList = document.getElementById('friendsList');
  friendsList.innerHTML = '';
  const friendUids = Object.keys(friends);
  syncOwnFriendCountStat(friendUids.length).catch(err => console.warn('Unable to sync friend count:', err));
  if (friendUids.length === 0) {
    friendsList.innerHTML = '<p class="friends-empty">No friends yet. Add someone below!</p>';
  } else {
    for (const fuid of friendUids) {
      const fname = await resolveFriendDisplayName(fuid, friends[fuid]);
      const row = document.createElement('div');
      row.className = 'friend-row';
      row.innerHTML = `
        <button class="friend-profile-trigger" type="button" title="View ${fname}'s statistics">
          <span class="friend-avatar">${fname.charAt(0).toUpperCase()}</span>
          <span class="friend-name">${fname}</span>
        </button>
        <div class="friend-actions">
          <button class="btn btn-sm btn-primary friend-challenge-btn">Challenge</button>
          <button class="btn btn-sm btn-ghost btn-danger-ghost friend-remove-btn">Remove</button>
        </div>
      `;
      row.querySelector('.friend-profile-trigger')?.addEventListener('click', () => openFriendStatsModal(fuid, fname));
      row.querySelector('.friend-challenge-btn')?.addEventListener('click', () => sendMatchRequest(fuid, fname));
      row.querySelector('.friend-remove-btn')?.addEventListener('click', () => removeFriend(fuid, fname));
      friendsList.appendChild(row);
    }
  }

  // Load pending incoming requests
  const reqSnap = await db.ref(`users/${uid}/friendRequests`).once('value');
  const requests = reqSnap.val() || {};
  const reqList  = document.getElementById('friendRequestsList');
  reqList.innerHTML = '';
  const reqUids = Object.keys(requests);
  const reqSection = document.getElementById('friendRequestsSection');
  reqSection.style.display = reqUids.length > 0 ? 'block' : 'none';

  for (const ruid of reqUids) {
    const reqData = requests[ruid];
    let rname = typeof reqData === 'object' && reqData?.fromUsername ? reqData.fromUsername : ruid;
    try {
      const nameSnap = await db.ref(`users/${ruid}/username`).once('value');
      rname = nameSnap.val() || rname;
    } catch (_) {}
    const row = document.createElement('div');
    row.className = 'friend-row';
    row.innerHTML = `
      <span class="friend-avatar">${rname.charAt(0).toUpperCase()}</span>
      <span class="friend-name">${rname}</span>
      <button class="btn btn-sm btn-primary" onclick="acceptFriendRequest('${ruid}','${rname}')">Accept</button>
      <button class="btn btn-sm btn-ghost" onclick="declineFriendRequest('${ruid}')">Decline</button>
    `;
    reqList.appendChild(row);
  }

  // Clear add friend field
  document.getElementById('addFriendInput').value = '';
  document.getElementById('addFriendError').style.display = 'none';
  document.getElementById('addFriendSuccess').style.display = 'none';
}

async function resolveFriendDisplayName(uid, friendData = null) {
  const storedName = typeof friendData === 'object' && friendData?.username ? friendData.username : null;
  if (storedName && storedName !== uid) return sanitizePlayerName(storedName, 'Player');

  const onlineName = getOnlinePlayerNameByUid(uid);
  if (onlineName) return onlineName;

  try {
    const nameSnap = await db.ref(`users/${uid}/username`).once('value');
    const name = nameSnap.val();
    if (name && name !== uid) return sanitizePlayerName(name, 'Player');
  } catch (_) {}

  return 'Player';
}

function getOnlinePlayerNameByUid(uid) {
  if (!uid) return null;
  if (uid === onlinePlayerUidByColor.w) {
    return sanitizePlayerName(document.getElementById('infoWhitePlayer')?.textContent || null, 'Player');
  }
  if (uid === onlinePlayerUidByColor.b) {
    return sanitizePlayerName(document.getElementById('infoBlackPlayer')?.textContent || null, 'Player');
  }
  return null;
}

async function sendFriendRequest() {
  const input    = document.getElementById('addFriendInput');
  const errorEl  = document.getElementById('addFriendError');
  const successEl = document.getElementById('addFriendSuccess');
  const targetUsername = input.value.trim().toLowerCase();

  errorEl.style.display   = 'none';
  successEl.style.display = 'none';

  if (!targetUsername) {
    errorEl.textContent = 'Enter a username.';
    errorEl.style.display = 'block';
    return;
  }
  if (targetUsername === currentUsername) {
    errorEl.textContent = "You can't add yourself.";
    errorEl.style.display = 'block';
    return;
  }

  // Look up target UID
  const snap = await db.ref(`usernames/${targetUsername}`).once('value');
  if (!snap.exists()) {
    errorEl.textContent = 'User not found.';
    errorEl.style.display = 'block';
    return;
  }

  const targetUid = snap.val();
  const myUid     = currentUser.uid;

  // Check not already friends
  const alreadySnap = await db.ref(`users/${myUid}/friends/${targetUid}`).once('value');
  if (alreadySnap.exists()) {
    errorEl.textContent = 'Already friends!';
    errorEl.style.display = 'block';
    return;
  }

  // Send request (stored under target's incoming requests)
  await db.ref(`users/${targetUid}/friendRequests/${myUid}`).set({
    fromUsername: sanitizePlayerName(currentUsername),
    sentAt: firebase.database.ServerValue.TIMESTAMP
  });

  successEl.textContent  = `Friend request sent to ${targetUsername}!`;
  successEl.style.display = 'block';
  input.value = '';
}

async function acceptFriendRequest(fromUid, fromName) {
  const myUid = currentUser.uid;
  let wasAlreadyFriend = false;
  try {
    const existingFriendSnap = await db.ref(`users/${myUid}/friends/${fromUid}`).once('value');
    wasAlreadyFriend = existingFriendSnap.exists();
  } catch (_) {}
  const displayFromName = sanitizePlayerName(
    fromName && fromName !== fromUid ? fromName : getOnlinePlayerNameByUid(fromUid),
    'Player'
  );
  const myFriendEntry = {
    username: displayFromName,
    addedAt: firebase.database.ServerValue.TIMESTAMP
  };
  const theirFriendEntry = {
    username: sanitizePlayerName(currentUsername),
    addedAt: firebase.database.ServerValue.TIMESTAMP
  };
  const updates = {};
  updates[`users/${myUid}/friends/${fromUid}`] = myFriendEntry;
  updates[`users/${myUid}/friendRequests/${fromUid}`] = null;

  try {
    updates[`users/${fromUid}/friends/${myUid}`] = theirFriendEntry;
    await db.ref().update(updates);
  } catch (err) {
    console.warn('Reciprocal friend write failed; using in-game accept handoff:', err);
    await db.ref(`users/${myUid}/friends/${fromUid}`).set(myFriendEntry);
    await db.ref(`users/${myUid}/friendRequests/${fromUid}`).remove();

    if (friendGameRef && currentGameFriendRequests?.[fromUid]?.toUid === myUid) {
      const gameUpdates = {};
      gameUpdates[`friendAccepts/${myUid}`] = {
        toUid: fromUid,
        fromUsername: sanitizePlayerName(currentUsername),
        toUsername: sanitizePlayerName(fromName),
        acceptedAt: firebase.database.ServerValue.TIMESTAMP
      };
      gameUpdates[`friendRequests/${fromUid}`] = null;
      await friendGameRef.update(gameUpdates);
    }
  }

  loadFriendsModal(); // refresh
  if (!wasAlreadyFriend) {
    adjustOwnFriendCountStat(1).catch(err => console.warn('Unable to update friend count:', err));
    recordFriendMadeInMatch(fromUid);
  }
  updateGameInfo();
}

async function declineFriendRequest(fromUid) {
  await db.ref(`users/${currentUser.uid}/friendRequests/${fromUid}`).remove();
  loadFriendsModal();
}

async function removeFriend(fuid, fname) {
  if (!confirm(`Remove ${fname} from your friends?`)) return;
  const myUid = currentUser.uid;
  let wasFriend = true;
  try {
    const existingFriendSnap = await db.ref(`users/${myUid}/friends/${fuid}`).once('value');
    wasFriend = existingFriendSnap.exists();
  } catch (_) {}
  const updates = {};
  updates[`users/${myUid}/friends/${fuid}`]  = null;
  updates[`users/${fuid}/friends/${myUid}`]  = null;
  try {
    await db.ref().update(updates);
  } catch (_) {
    await db.ref(`users/${myUid}/friends/${fuid}`).remove();
  }

  if (friendGameRef && (onlinePlayerUidByColor.w === fuid || onlinePlayerUidByColor.b === fuid)) {
    currentGameFriendRemovals[myUid] = { toUid: fuid };
    delete currentGameFriendAccepts[myUid];
    delete currentGameFriendAccepts[fuid];
    delete currentGameFriendRequests[myUid];
    delete currentGameFriendRequests[fuid];

    const gameUpdates = {};
    gameUpdates[`friendRemovals/${myUid}`] = {
      toUid: fuid,
      removedAt: firebase.database.ServerValue.TIMESTAMP
    };
    gameUpdates[`friendAccepts/${myUid}`] = null;
    gameUpdates[`friendAccepts/${fuid}`] = null;
    gameUpdates[`friendRequests/${myUid}`] = null;
    gameUpdates[`friendRequests/${fuid}`] = null;
    friendGameRef.update(gameUpdates).catch(err => {
      console.warn('Unable to sync in-game friend removal:', err);
    });
    updateGameInfo();
  }

  if (wasFriend) {
    adjustOwnFriendCountStat(-1).catch(err => console.warn('Unable to update friend count:', err));
  }
  loadFriendsModal();
}

async function addFriendByUsername(username) {
  // Quick-add from the in-game add button
  if (!currentUser) { openAuthModal('signup'); return; }
  const snap = await db.ref(`usernames/${username.toLowerCase()}`).once('value');
  if (!snap.exists()) { alert('User not found.'); return; }
  const targetUid = snap.val();
  const alreadySnap = await db.ref(`users/${currentUser.uid}/friends/${targetUid}`).once('value');
  if (alreadySnap.exists()) { alert('Already friends!'); return; }
  await db.ref(`users/${targetUid}/friendRequests/${currentUser.uid}`).set({
    fromUsername: sanitizePlayerName(currentUsername),
    sentAt: firebase.database.ServerValue.TIMESTAMP
  });
  alert(`Friend request sent to ${username}!`);
}

/* ══════════════════════════════════════════
   MATCH REQUESTS
══════════════════════════════════════════ */

// Toggle the ⋯ popup for a specific friend row
function toggleFriendMenu(e, fuid) {
  e.stopPropagation();
  // Close any other open menus first
  document.querySelectorAll('.friend-more-menu').forEach(m => {
    if (m.id !== `friendMenu_${fuid}`) m.style.display = 'none';
  });
  const menu = document.getElementById(`friendMenu_${fuid}`);
  if (menu) menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
}

// Close ⋯ menus when clicking elsewhere
document.addEventListener('click', (e) => {
  // Only close if the click was not inside a friend-more-wrap
  if (!e.target.closest('.friend-more-wrap')) {
    document.querySelectorAll('.friend-more-menu').forEach(m => m.style.display = 'none');
  }
});

async function sendMatchRequest(toUid, toUsername) {
  if (!currentUser) return;
  // Close the menu
  document.getElementById(`friendMenu_${toUid}`)?.style && (document.getElementById(`friendMenu_${toUid}`).style.display = 'none');

  // Write the request into the target user's matchRequests node
  const requestData = {
    fromUid:      currentUser.uid,
    fromUsername: currentUsername,
    sentAt:       firebase.database.ServerValue.TIMESTAMP
  };
  await db.ref(`users/${toUid}/matchRequests/${currentUser.uid}`).set(requestData);

  // Brief feedback in the friends modal
  const list = document.getElementById('friendsList');
  if (list) {
    const flash = document.createElement('p');
    flash.style.cssText = 'font-size:0.78rem;color:var(--green-bright);margin-top:6px;';
    flash.textContent = `Challenge sent to ${toUsername}!`;
    list.parentNode.insertBefore(flash, list.nextSibling);
    setTimeout(() => flash.remove(), 3000);
  }
}

// Listen for incoming match requests — starts after Firebase init
let matchRequestListener = null;

function startMatchRequestListener() {
  if (!currentUser || !db) return;
  const uid = currentUser.uid;

  if (matchRequestListener) {
    db.ref(`users/${uid}/matchRequests`).off('child_added', matchRequestListener);
  }

  matchRequestListener = db.ref(`users/${uid}/matchRequests`).on('child_added', snap => {
    const req = snap.val();
    if (!req) return;
    showMatchRequestNotification(snap.key, req.fromUsername, req.fromUid);
  });
}

function stopMatchRequestListener() {
  if (matchRequestListener && currentUser && db) {
    db.ref(`users/${currentUser.uid}/matchRequests`).off('child_added', matchRequestListener);
    matchRequestListener = null;
  }
}

/* ══════════════════════════════════════════
   UNIFIED NOTIFICATION SYSTEM
   All notifications funnel through pushNotif()
══════════════════════════════════════════ */

const NOTIF_AUTO_DISMISS_MS = 6000;   // plain notifications auto-dismiss
const NOTIF_ACTION_DISMISS_MS = 0;    // action notifications (match/friend req) stay until actioned

let notifCounter = 0;

/**
 * pushNotif({ type, icon, title, body, actions, autoDismiss })
 *  type        : 'message' | 'friend' | 'match' | 'info'
 *  icon        : emoji string
 *  title       : bold heading text
 *  body        : sub-text (optional)
 *  actions     : array of { label, cls, onclick } (optional)
 *  autoDismiss : ms until auto-close, 0 = never (default: 6000)
 */
function pushNotif({ type = 'info', icon = '♟', title = '', body = '', actions = [], autoDismiss = NOTIF_AUTO_DISMISS_MS }) {
  const container = document.getElementById('notifContainer');
  if (!container) return;

  const id   = `notif_${++notifCounter}`;
  const wrap = document.createElement('div');
  wrap.className = `notif notif-${type}`;
  wrap.id        = id;

  const actionsHtml = actions.map(a =>
    `<button class="btn btn-sm ${a.cls || 'btn-ghost'}" onclick="${a.onclick}; dismissNotif('${id}')">${a.label}</button>`
  ).join('');

  wrap.innerHTML = `
    <div class="notif-icon">${icon}</div>
    <div class="notif-body">
      <p class="notif-title">${title}</p>
      ${body ? `<p class="notif-sub">${body}</p>` : ''}
      ${actionsHtml ? `<div class="notif-actions">${actionsHtml}</div>` : ''}
    </div>
    <button class="notif-close" onclick="dismissNotif('${id}')" title="Dismiss">✕</button>
  `;

  // Insert at top (newest first)
  container.insertBefore(wrap, container.firstChild);

  // Animate in
  requestAnimationFrame(() => wrap.classList.add('notif-show'));

  // Auto-dismiss
  if (autoDismiss > 0) {
    setTimeout(() => dismissNotif(id), autoDismiss);
  }

  return id;
}

function dismissNotif(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('notif-show');
  setTimeout(() => el.remove(), 300);
}

// ── Replace old showMatchRequestNotification ──
function showMatchRequestNotification(reqKey, fromUsername, fromUid) {
  // Avoid duplicates
  if (document.getElementById(`notif_mr_${reqKey}`)) return;

  const id = pushNotif({
    type:        'match',
    icon:        '♟',
    title:       `<strong>${fromUsername}</strong> has challenged you to a game`,
    actions: [
      { label: 'Accept',  cls: 'btn-primary', onclick: `acceptMatchRequest('${reqKey}','${fromUid}','${fromUsername}')` },
      { label: 'Decline', cls: 'btn-ghost',   onclick: `declineMatchRequest('${reqKey}')` }
    ],
    autoDismiss: 0   // stays until actioned
  });

  // Tag it so we can dedupe
  if (id) document.getElementById(id).id = `notif_mr_${reqKey}`;
}

// Keep old dismissMatchNotif name working (used by accept/decline callbacks)
function dismissMatchNotif(reqKey) {
  dismissNotif(`notif_mr_${reqKey}`);
}

async function acceptMatchRequest(reqKey, fromUid, fromUsername) {
  // Remove the request from Firebase
  await db.ref(`users/${currentUser.uid}/matchRequests/${reqKey}`).remove();
  dismissMatchNotif(reqKey);

  // Close friends modal if open
  closeModal('friendsModal');

  // The accepting user becomes the host (black), sender becomes joiner (white)
  // We reuse the existing friend game flow — just auto-create and share code
  // by opening the friend modal pre-filled as host
  myColor        = 'b';
  isFlipped      = shouldAutoFlipForBlack('b');   // host is black → black at bottom when enabled
  hostUsername   = currentUsername;
  joinerUsername = fromUsername;

  // Generate a join code and write the game to Firebase, then notify the sender
  playerId       = currentUser.uid;
  friendJoinCode = generateJoinCode();
  gameMode       = 'friend';

  const gameData = {
    players:     { host: playerId },
    usernames:   { host: sanitizePlayerName(currentUsername) },
    colors:      { [playerId]: 'b' },
    hostColor:   'b',
    timeControl: QP_TIME_SECS,
    board:       boardToFirebase(INITIAL_BOARD),
    currentTurn: 'w',
    moveHistory: [],
    gameOver:    false,
    lastMove:    null,
    enPassantSq: null,
    castlingRights: { wK: true, wQ: true, bK: true, bQ: true },
    capturedByWhite: [],
    capturedByBlack: [],
    halfMoveClock: 0,
    timerWhiteSecs: QP_TIME_SECS,
    timerBlackSecs: QP_TIME_SECS,
    timerLimitSecs: QP_TIME_SECS,
    createdAt:   firebase.database.ServerValue.TIMESTAMP
  };

  await db.ref(`games/${friendJoinCode}`).set(gameData);

  // Notify the requester with the join code
  await db.ref(`users/${fromUid}/matchAccepted/${currentUser.uid}`).set({
    joinCode:        friendJoinCode,
    acceptedBy:      currentUsername,
    acceptedByUid:   currentUser.uid
  });

  // Start listening for the game
  setupGameListener(friendJoinCode, false);

  // Show a small modal telling this player to wait
  showMatchAcceptedWaiting(fromUsername, friendJoinCode);
}

function showMatchAcceptedWaiting(fromUsername, code) {
  // Reuse the friend modal to show the waiting state
  document.getElementById('friendModal').style.display = 'flex';
  document.getElementById('joinCodeDisplay').style.display = 'block';
  document.getElementById('joinCodeBox').textContent = code;
}

async function declineMatchRequest(reqKey) {
  await db.ref(`users/${currentUser.uid}/matchRequests/${reqKey}`).remove();
  dismissMatchNotif(reqKey);
}

// Listen for match accepted notifications (for the player who sent the request)
let matchAcceptedListener = null;

function startMatchAcceptedListener() {
  if (!currentUser || !db) return;
  const uid = currentUser.uid;

  if (matchAcceptedListener) {
    db.ref(`users/${uid}/matchAccepted`).off('child_added', matchAcceptedListener);
  }

  matchAcceptedListener = db.ref(`users/${uid}/matchAccepted`).on('child_added', snap => {
    const data = snap.val();
    if (!data) return;

    // Remove the notification from DB
    db.ref(`users/${uid}/matchAccepted/${snap.key}`).remove();

    // Auto-join the game
    friendJoinCode = data.joinCode;
    playerId       = currentUser.uid;
    myColor        = 'w';
    isFlipped      = false;  // sender is white → white at bottom
    gameMode       = 'friend';
    joinerUsername = sanitizePlayerName(currentUsername);
    hostUsername   = sanitizePlayerName(data.acceptedBy);

    const updates = {};
    updates[`games/${data.joinCode}/players/joiner`]     = playerId;
    updates[`games/${data.joinCode}/usernames/joiner`]   = sanitizePlayerName(currentUsername);
    updates[`games/${data.joinCode}/colors/${playerId}`] = 'w';

    db.ref().update(updates).then(() => {
      closeModal('friendsModal');
      setupGameListener(friendJoinCode, true);
    }).catch(err => {
      console.error('Accepted match join failed:', err);
      alert('Unable to join the accepted match right now. Please try again.');
    });
  });
}

/* ══════════════════════════════════════════
   IN-GAME CHAT
══════════════════════════════════════════ */

let inGameChatListener = null;

function showInGameChat() {
  // Hide chat if either player is a guest — guests have no messaging features
  if (currentUser && currentUser.isAnonymous) return;
  // Also hide if opponent is a guest (their username starts with Guest_ and
  // won't be in the usernames index, but we can check opponentUsername)
  if (opponentUsername && opponentUsername.startsWith('Guest_')) return;
  document.getElementById('inGameChatCard').style.display = 'block';
  loadInGameChat();
}

function hideInGameChat() {
  document.getElementById('inGameChatCard').style.display = 'none';
  if (inGameChatListener && friendGameRef) {
    friendGameRef.child('chat').off('child_added', inGameChatListener);
    inGameChatListener = null;
  }
}

function loadInGameChat() {
  if (!friendGameRef) return;
  const msgEl = document.getElementById('inGameChatMessages');
  msgEl.innerHTML = '';

  if (inGameChatListener) {
    friendGameRef.child('chat').off('child_added', inGameChatListener);
  }

  inGameChatListener = friendGameRef.child('chat').on('child_added', snap => {
    const msg = snap.val();
    if (!msg) return;
    appendChatMessage(msgEl, msg.username, msg.text, msg.uid === currentUser?.uid);
  });

  // Enter to send
  const input = document.getElementById('inGameChatInput');
  input.onkeydown = e => { if (e.key === 'Enter') sendInGameMessage(); };
}

function appendChatMessage(container, username, text, isOwn) {
  const div = document.createElement('div');
  div.className = 'chat-msg' + (isOwn ? ' chat-msg-own' : '');
  div.innerHTML = `
    <span class="chat-msg-author">${isOwn ? 'You' : username}</span>
    <span class="chat-msg-text">${escapeHtml(text)}</span>
  `;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function sendInGameMessage() {
  const input = document.getElementById('inGameChatInput');
  const text  = input.value.trim();
  if (!text || !friendGameRef || !currentUser) return;
  input.value = '';
  friendGameRef.child('chat').push({
    uid:      currentUser.uid,
    username: currentUsername,
    text:     text,
    sentAt:   firebase.database.ServerValue.TIMESTAMP
  });
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ══════════════════════════════════════════
   FRIEND DM CHAT
══════════════════════════════════════════ */

let activeDmUid      = null;  // UID of friend we're currently chatting with
let activeDmListener = null;  // Firebase listener for active DM thread
let activeDmChatId   = null;
let dmUnreadCounts   = {};    // { uid: count }
let dmNotifRefs      = [];
let friendRequestNotifRef = null;
let friendRequestNotifHandler = null;

function dmChatId(uid1, uid2) {
  if (uid1 === DIGICHAT_THREAD_ID || uid2 === DIGICHAT_THREAD_ID) return DIGICHAT_CHAT_ID;
  return [uid1, uid2].sort().join('_');
}

function isDigichatThread(threadId) {
  return threadId === DIGICHAT_THREAD_ID;
}

function getThreadChatId(threadId) {
  return isDigichatThread(threadId) ? DIGICHAT_CHAT_ID : dmChatId(currentUser.uid, threadId);
}

function getThreadAvatar(name, isGlobal = false) {
  return isGlobal ? 'D' : sanitizePlayerName(name, 'Player').charAt(0).toUpperCase();
}

function openMessagesModal() {
  document.getElementById('profileDropdown').style.display = 'none';
  document.getElementById('messagesModal').style.display = 'flex';
  document.getElementById('dmConversationList').style.display = 'block';
  document.getElementById('dmChatView').style.display = 'none';
  // Clear unread counts
  dmUnreadCounts = {};
  updateUnreadBadge();
  loadDmThreadList();
}

async function loadDmThreadList() {
  if (!currentUser || !db) return;
  const uid      = currentUser.uid;
  const threadEl = document.getElementById('dmThreadList');
  const noMsg    = document.getElementById('dmNoThreads');
  threadEl.innerHTML = '';
  noMsg.style.display = 'none';

  await appendDmThreadRow({
    threadId: DIGICHAT_THREAD_ID,
    name: DIGICHAT_NAME,
    chatId: DIGICHAT_CHAT_ID,
    isGlobal: true
  });

  // Get friends list to show threads for
  const friendsSnap = await db.ref(`users/${uid}/friends`).once('value');
  const friends = friendsSnap.val() || {};
  const fUids   = Object.keys(friends);

  if (fUids.length === 0) {
    return;
  }
  await appendFriendDmRows(fUids, friends);
}

async function appendDmThreadRow({ threadId, name, chatId, isGlobal = false }) {
  const threadEl = document.getElementById('dmThreadList');
  const uid = currentUser.uid;
  const now = Date.now();
  const oneDayAgo = now - 24 * 60 * 60 * 1000;

  const lastSnap = await db.ref(`chats/${chatId}`)
    .orderByChild('sentAt').limitToLast(1).once('value');
  let preview = isGlobal ? 'Everyone with an account is here' : 'No messages yet';
  let lastTime = '';
  if (lastSnap.exists()) {
    lastSnap.forEach(s => {
      const v = s.val();
      if (v.sentAt > oneDayAgo) {
        const sender = v.uid === uid ? 'You' : sanitizePlayerName(v.username, 'Player');
        preview = `${sender}: ${String(v.text || '').substring(0, 40)}${String(v.text || '').length > 40 ? '...' : ''}`;
        const d = new Date(v.sentAt);
        lastTime = d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
      }
    });
  }

  const row = document.createElement('div');
  row.className = `dm-thread-row${isGlobal ? ' dm-thread-digichat' : ''}`;
  row.innerHTML = `
    <span class="friend-avatar">${getThreadAvatar(name, isGlobal)}</span>
    <div class="dm-thread-info">
      <span class="dm-thread-name">${escapeHtml(name)}</span>
      <span class="dm-thread-preview">${escapeHtml(preview)}</span>
    </div>
    <span class="dm-thread-time">${lastTime}</span>
  `;
  row.onclick = () => openDmChat(threadId, name);
  threadEl.appendChild(row);
}

async function appendFriendDmRows(fUids, friends) {
  for (const fuid of fUids) {
    const fname = await resolveFriendDisplayName(fuid, friends[fuid]);
    await appendDmThreadRow({
      threadId: fuid,
      name: fname,
      chatId: dmChatId(currentUser.uid, fuid)
    });
  }
}

function openDmChat(fuid, fname) {
  if (!currentUser || !db) return;
  if (activeDmListener && activeDmChatId) {
    db.ref(`chats/${activeDmChatId}`).off('child_added', activeDmListener);
    activeDmListener = null;
  }

  activeDmUid = fuid;
  activeDmChatId = getThreadChatId(fuid);
  dmUnreadCounts[fuid] = 0;
  updateUnreadBadge();
  document.getElementById('dmConversationList').style.display = 'none';
  document.getElementById('dmChatView').style.display        = 'flex';
  document.getElementById('dmChatTitle').textContent         = fname;

  const msgEl = document.getElementById('dmChatMessages');
  msgEl.innerHTML = '';

  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;

  activeDmListener = db.ref(`chats/${activeDmChatId}`)
    .orderByChild('sentAt').startAt(oneDayAgo)
    .on('child_added', snap => {
      const msg = snap.val();
      if (!msg) return;
      appendChatMessage(msgEl, msg.username, msg.text, msg.uid === currentUser.uid);
    });

  const input = document.getElementById('dmChatInput');
  input.onkeydown = e => { if (e.key === 'Enter') sendDmMessage(); };
  input.focus();
}

function closeDmChat() {
  stopActiveDmChatListener();
  document.getElementById('dmConversationList').style.display = 'block';
  document.getElementById('dmChatView').style.display         = 'none';
  loadDmThreadList();
}

function stopActiveDmChatListener() {
  if (activeDmListener && activeDmChatId && db) {
    db.ref(`chats/${activeDmChatId}`).off('child_added', activeDmListener);
  }
  activeDmListener = null;
  activeDmUid = null;
  activeDmChatId = null;
}

function sendDmMessage() {
  const input = document.getElementById('dmChatInput');
  const text  = input.value.trim();
  if (!text || !activeDmUid || !currentUser) return;
  input.value = '';

  const chatId = getThreadChatId(activeDmUid);
  db.ref(`chats/${chatId}`).push({
    uid:      currentUser.uid,
    username: currentUsername,
    text:     text,
    sentAt:   firebase.database.ServerValue.TIMESTAMP
  });
}

function startDmNotifListener() {
  if (!currentUser || !db) return;
  const uid = currentUser.uid;
  stopDmNotifListener();

  watchMessageThread({
    threadId: DIGICHAT_THREAD_ID,
    chatId: DIGICHAT_CHAT_ID,
    name: DIGICHAT_NAME,
    isGlobal: true
  });

  db.ref(`users/${uid}/friends`).once('value').then(snap => {
    const friends = snap.val() || {};

    Object.keys(friends).forEach(fuid => {
      const friendName = typeof friends[fuid] === 'object' && friends[fuid]?.username ? friends[fuid].username : 'Friend';
      watchMessageThread({
        threadId: fuid,
        chatId: dmChatId(uid, fuid),
        name: sanitizePlayerName(friendName, 'Friend')
      });
    });
  });
}

function watchMessageThread({ threadId, chatId, name, isGlobal = false }) {
  const uid = currentUser.uid;
  const listenStart = Date.now();
  const query = db.ref(`chats/${chatId}`).orderByChild('sentAt').startAt(listenStart);
  const handler = query.on('child_added', msgSnap => {
    const msg = msgSnap.val();
    if (!msg || msg.uid === uid) return;
    const modalOpen = document.getElementById('messagesModal').style.display !== 'none';
    const inThread  = activeDmUid === threadId;
    if (modalOpen && inThread) return;

    dmUnreadCounts[threadId] = (dmUnreadCounts[threadId] || 0) + 1;
    updateUnreadBadge();
    const sender = sanitizePlayerName(msg.username, 'Player');
    const title = isGlobal
      ? `New message in <strong>${DIGICHAT_NAME}</strong>`
      : `New message from <strong>${sender}</strong>`;
    const openName = isGlobal ? DIGICHAT_NAME : sender;
    pushNotif({
      type:        'message',
      icon:        '💬',
      title,
      body:        String(msg.text || '').substring(0, 60) + (String(msg.text || '').length > 60 ? '...' : ''),
      actions:     [{ label: 'Open', cls: 'btn-primary', onclick: `openMessagesModal(); openDmChat('${threadId}','${openName}')` }],
      autoDismiss: NOTIF_AUTO_DISMISS_MS
    });
  });
  dmNotifRefs.push({ query, handler });
}

function stopDmNotifListener() {
  dmNotifRefs.forEach(({ query, handler }) => query.off('child_added', handler));
  dmNotifRefs = [];
}

// Also notify on incoming friend requests
function startFriendRequestNotifListener() {
  if (!currentUser || !db) return;
  const uid = currentUser.uid;
  stopFriendRequestNotifListener();

  friendRequestNotifRef = db.ref(`users/${uid}/friendRequests`);
  friendRequestNotifHandler = friendRequestNotifRef.on('child_added', snap => {
    if (!snap.exists()) return;
    const reqData = snap.val();
    const fromUid = snap.key;
    const fallbackName = typeof reqData === 'object' && reqData?.fromUsername ? reqData.fromUsername : 'Someone';
    db.ref(`users/${fromUid}/username`).once('value').then(nameSnap => {
      const fromUsername = nameSnap.val() || fallbackName;
      pushNotif({
        type:        'friend',
        icon:        '👤',
        title:       `<strong>${fromUsername}</strong> sent you a friend request`,
        actions: [
          { label: 'Accept',  cls: 'btn-primary', onclick: `acceptFriendRequest('${fromUid}','${fromUsername}')` },
          { label: 'Decline', cls: 'btn-ghost',   onclick: `declineFriendRequest('${fromUid}')` }
        ],
        autoDismiss: 0
      });
    }).catch(() => {
      pushNotif({
        type:        'friend',
        icon:        '👤',
        title:       `<strong>${fallbackName}</strong> sent you a friend request`,
        actions: [
          { label: 'Accept',  cls: 'btn-primary', onclick: `acceptFriendRequest('${fromUid}','${fallbackName}')` },
          { label: 'Decline', cls: 'btn-ghost',   onclick: `declineFriendRequest('${fromUid}')` }
        ],
        autoDismiss: 0
      });
    });
  });
}

function stopFriendRequestNotifListener() {
  if (friendRequestNotifRef && friendRequestNotifHandler) {
    friendRequestNotifRef.off('child_added', friendRequestNotifHandler);
  }
  friendRequestNotifRef = null;
  friendRequestNotifHandler = null;
}

function updateUnreadBadge() {
  const total  = Object.values(dmUnreadCounts).reduce((a, b) => a + b, 0);
  const badge  = document.getElementById('unreadBadge');
  if (!badge) return;
  if (total > 0) {
    badge.textContent    = total > 9 ? '9+' : total;
    badge.style.display  = 'inline-flex';
  } else {
    badge.style.display  = 'none';
  }
}

/* ══════════════════════════════════════════
   ADDITIONAL MULTIPLAYER FUNCTIONS
══════════════════════════════════════════ */

// Firebase drops null values from arrays, so we encode null as "." for storage
function boardToFirebase(b) {
  return b.map(row => row.map(sq => sq === null ? '.' : sq));
}

function boardFromFirebase(raw) {
  if (!raw) return null;
  // raw may be a plain object (Firebase converts arrays to objects keyed by index)
  const rows = Array.isArray(raw) ? raw : Object.keys(raw).sort((a,b) => Number(a)-Number(b)).map(k => raw[k]);
  return rows.map(row => {
    const cols = Array.isArray(row) ? row : Object.keys(row).sort((a,b) => Number(a)-Number(b)).map(k => row[k]);
    return cols.map(sq => (sq === '.' || sq === undefined || sq === null) ? null : sq);
  });
}

function sanitizePlayerName(name, fallback = 'Player') {
  return (typeof name === 'string' && name.trim() && name !== 'Opponent') ? name.trim() : fallback;
}

function playerSlotForUid(gameData, uid) {
  if (!gameData || !gameData.players || !uid) return null;
  if (gameData.players.host === uid) return 'host';
  if (gameData.players.joiner === uid) return 'joiner';
  return null;
}

function playerNameForSlot(gameData, slot, fallback = 'Player') {
  const names = gameData?.usernames || {};
  return sanitizePlayerName(names[slot], fallback);
}

function syncLocalNamesFromGame(gameData) {
  if (!gameData) return;
  const mySlot = playerSlotForUid(gameData, currentUser?.uid);
  const otherSlot = mySlot === 'host' ? 'joiner' : mySlot === 'joiner' ? 'host' : null;
  onlinePlayerUidByColor = { w: null, b: null };
  currentGameRanked = gameData.ranked === true;
  currentGameElos = gameData.playerElos || {};
  currentDrawOffer = gameData.drawOffer || null;
  currentGameFriendRequests = gameData.friendRequests || {};
  currentGameFriendAccepts = gameData.friendAccepts || {};
  currentGameFriendRemovals = gameData.friendRemovals || {};

  if (gameData.colors) {
    Object.entries(gameData.colors).forEach(([uid, color]) => {
      if (color === 'w' || color === 'b') onlinePlayerUidByColor[color] = uid;
    });
  }

  hostUsername   = playerNameForSlot(gameData, 'host', hostUsername || 'Player');
  joinerUsername = playerNameForSlot(gameData, 'joiner', joinerUsername || 'Player');

  if (otherSlot) {
    opponentUsername = playerNameForSlot(
      gameData,
      otherSlot,
      otherSlot === 'host' ? hostUsername || 'Player' : joinerUsername || 'Player'
    );
  }
}

function gameStateForFirebase() {
  return {
    board:           boardToFirebase(board),
    currentTurn:     currentTurn,
    moveHistory:     moveHistory,
    gameOver:        gameOver,
    lastMove:        lastMove || null,
    enPassantSq:     enPassantSq || null,
    castlingRights:  castlingRights,
    capturedByWhite: capturedByWhite,
    capturedByBlack: capturedByBlack,
    halfMoveClock:   halfMoveClock,
    timerWhiteSecs:  timerWhiteSecs,
    timerBlackSecs:  timerBlackSecs,
    timerLimitSecs:  timerLimitSecs,
    lastMoveBy:      currentUser?.uid || null,
    updatedAt:       firebase.database.ServerValue.TIMESTAMP
  };
}

function normalizeMoveHistory(mh) {
  if (!mh) return [];
  return Array.isArray(mh) ? mh : Object.values(mh);
}

function boardsEqual(a, b) {
  if (!a || !b || a.length !== 8 || b.length !== 8) return false;
  for (let r = 0; r < 8; r++) {
    if (!a[r] || !b[r] || a[r].length !== 8 || b[r].length !== 8) return false;
    for (let c = 0; c < 8; c++) {
      if (a[r][c] !== b[r][c]) return false;
    }
  }
  return true;
}

/** True when Firebase state differs from local board — never skip applying in this case. */
function needsApplyGameState(gameData) {
  if (!gameData) return false;
  const remoteBoard = boardFromFirebase(gameData.board);
  if (!remoteBoard) return true;
  const remoteTurn  = gameData.currentTurn || 'w';
  const remoteMoves = normalizeMoveHistory(gameData.moveHistory);
  if (!!gameData.gameOver !== gameOver) return true;
  if (gameData.gameOverReason) return true;
  if (remoteTurn !== currentTurn) return true;
  if (remoteMoves.length !== moveHistory.length) return true;
  if (!boardsEqual(remoteBoard, board)) return true;
  return false;
}

function gameSnapshotSignature(gameData) {
  if (!gameData) return '';
  return JSON.stringify({
    players: gameData.players || null,
    usernames: gameData.usernames || null,
    board: gameData.board || null,
    currentTurn: gameData.currentTurn || 'w',
    moveHistory: normalizeMoveHistory(gameData.moveHistory),
    gameOver: !!gameData.gameOver,
    gameOverTitle: gameData.gameOverTitle || null,
    gameOverSub: gameData.gameOverSub || null,
    gameOverIcon: gameData.gameOverIcon || null,
    rematchRequest: gameData.rematchRequest || null,
    lastMove: gameData.lastMove || null,
    enPassantSq: gameData.enPassantSq || null,
    castlingRights: gameData.castlingRights || null,
    capturedByWhite: gameData.capturedByWhite || [],
    capturedByBlack: gameData.capturedByBlack || [],
    halfMoveClock: Number.isFinite(gameData.halfMoveClock) ? gameData.halfMoveClock : null,
    timeControl: gameData.timeControl ?? null,
    timerWhiteSecs: Number.isFinite(gameData.timerWhiteSecs) ? gameData.timerWhiteSecs : null,
    timerBlackSecs: Number.isFinite(gameData.timerBlackSecs) ? gameData.timerBlackSecs : null,
    timerLimitSecs: Number.isFinite(gameData.timerLimitSecs) ? gameData.timerLimitSecs : null,
    friendRequests: gameData.friendRequests || null,
    friendAccepts: gameData.friendAccepts || null,
    friendRemovals: gameData.friendRemovals || null,
    drawOffer: gameData.drawOffer || null,
    ranked: gameData.ranked === true,
    matchType: gameData.matchType || null,
    playerElos: gameData.playerElos || null
  });
}

function mirrorInGameFriendRequests(gameData) {
  if (!currentUser || !db || !gameData?.friendRequests) return;

  Object.entries(gameData.friendRequests).forEach(([fromUid, request]) => {
    if (!request || request.toUid !== currentUser.uid || fromUid === currentUser.uid) return;
    if (gameData.friendAccepts?.[currentUser.uid]?.toUid === fromUid) return;
    const requestKey = `${fromUid}:${request.sentAt || 'pending'}`;
    if (mirroredInGameFriendRequests.has(requestKey)) return;
    mirroredInGameFriendRequests.add(requestKey);

    db.ref(`users/${currentUser.uid}/friendRequests/${fromUid}`).set({
      fromUsername: sanitizePlayerName(request.fromUsername),
      sentAt: request.sentAt || firebase.database.ServerValue.TIMESTAMP
    }).catch(err => {
      mirroredInGameFriendRequests.delete(requestKey);
      console.error('Failed to mirror in-game friend request:', err);
    });
  });
}

function mirrorInGameFriendAccepts(gameData) {
  if (!currentUser || !db || !gameData?.friendAccepts) return;

  Object.entries(gameData.friendAccepts).forEach(([fromUid, accept]) => {
    if (!accept || accept.toUid !== currentUser.uid || fromUid === currentUser.uid) return;
    const acceptKey = `${fromUid}:${accept.acceptedAt || 'accepted'}`;
    if (mirroredInGameFriendAccepts.has(acceptKey)) return;
    mirroredInGameFriendAccepts.add(acceptKey);

    db.ref(`users/${currentUser.uid}/friends/${fromUid}`).once('value').then(existingFriendSnap => {
      const wasAlreadyFriend = existingFriendSnap.exists();
      return db.ref(`users/${currentUser.uid}/friends/${fromUid}`).set({
        username: sanitizePlayerName(accept.fromUsername),
        addedAt: accept.acceptedAt || firebase.database.ServerValue.TIMESTAMP
      }).then(() => wasAlreadyFriend);
    }).then(wasAlreadyFriend => {
      db.ref(`users/${currentUser.uid}/friendRequests/${fromUid}`).remove().catch(() => {});
      if (!wasAlreadyFriend) {
        adjustOwnFriendCountStat(1).catch(err => console.warn('Unable to update friend count:', err));
        recordFriendMadeInMatch(fromUid);
      }
      updateGameInfo();
    }).catch(err => {
      mirroredInGameFriendAccepts.delete(acceptKey);
      console.error('Failed to mirror in-game friend acceptance:', err);
    });
  });
}

function mirrorInGameFriendRemovals(gameData) {
  if (!currentUser || !db || !gameData?.friendRemovals) return;

  Object.entries(gameData.friendRemovals).forEach(([fromUid, removal]) => {
    if (!removal || removal.toUid !== currentUser.uid || fromUid === currentUser.uid) return;
    const removalKey = `${fromUid}:${removal.removedAt || 'removed'}`;
    if (mirroredInGameFriendRemovals.has(removalKey)) return;
    mirroredInGameFriendRemovals.add(removalKey);

    db.ref(`users/${currentUser.uid}/friends/${fromUid}`).once('value').then(existingFriendSnap => {
      if (!existingFriendSnap.exists()) return false;
      return db.ref(`users/${currentUser.uid}/friends/${fromUid}`).remove().then(() => true);
    }).then(wasFriend => {
      if (wasFriend) {
        adjustOwnFriendCountStat(-1).catch(err => console.warn('Unable to update friend count:', err));
      }
      updateGameInfo();
    }).catch(err => {
      mirroredInGameFriendRemovals.delete(removalKey);
      console.error('Failed to mirror in-game friend removal:', err);
    });
  });
}

function stopGameSyncPoller() {
  if (gameSyncPollId) {
    clearInterval(gameSyncPollId);
    gameSyncPollId = null;
  }
}

function detachGameFieldListeners() {
  gameFieldListeners.forEach(({ ref, event, handler }) => ref.off(event, handler));
  gameFieldListeners = [];
  if (gameFieldDebounceId) {
    clearTimeout(gameFieldDebounceId);
    gameFieldDebounceId = null;
  }
}

function applySyncedGameState(gameData) {
  const wasReviewing = exitOnlineBoardReviewForRemoteUpdate();
  const parsedBoard = boardFromFirebase(gameData.board);
  if (!parsedBoard || parsedBoard.length !== 8 || parsedBoard.some(r => !r || r.length !== 8)) {
    console.error('Invalid board from Firebase:', parsedBoard);
    return false;
  }

  board           = parsedBoard;
  currentTurn     = gameData.currentTurn || 'w';
  moveHistory     = normalizeMoveHistory(gameData.moveHistory);
  gameOver        = !!gameData.gameOver;
  lastMove        = gameData.lastMove || null;
  enPassantSq     = gameData.enPassantSq || null;
  castlingRights  = gameData.castlingRights || { wK: true, wQ: true, bK: true, bQ: true };
  capturedByWhite = Array.isArray(gameData.capturedByWhite) ? gameData.capturedByWhite : Object.values(gameData.capturedByWhite || {});
  capturedByBlack = Array.isArray(gameData.capturedByBlack) ? gameData.capturedByBlack : Object.values(gameData.capturedByBlack || {});
  halfMoveClock   = Number.isFinite(gameData.halfMoveClock) ? gameData.halfMoveClock : moveHistory.length;
  timerLimitSecs  = Number.isFinite(gameData.timerLimitSecs) ? gameData.timerLimitSecs
                   : Number.isFinite(gameData.timeControl) ? gameData.timeControl
                   : timerLimitSecs;
  timerWhiteSecs  = Number.isFinite(gameData.timerWhiteSecs) ? gameData.timerWhiteSecs : timerWhiteSecs;
  timerBlackSecs  = Number.isFinite(gameData.timerBlackSecs) ? gameData.timerBlackSecs : timerBlackSecs;
  selectedSq      = null;
  legalMoves      = [];
  rememberOnlinePositionSnapshot();
  if (wasReviewing && gameMode === 'friend' && !gameOver && timerLimitSecs > 0) startTimers();

  return true;
}

/* ══════════════════════════════════════════
   PLAY ONLINE — COLOR CHOICE & MATCHMAKING
══════════════════════════════════════════ */

// Track the host's color preference in the Create Game form
let createColorChoice = 'b'; // 'b' | 'w' | 'r'

function setColorChoice(color) {
  createColorChoice = color;
  document.getElementById('colorChoiceBlack').classList.toggle('active', color === 'b');
  document.getElementById('colorChoiceWhite').classList.toggle('active', color === 'w');
  document.getElementById('colorChoiceRandom').classList.toggle('active', color === 'r');
}

/* ── QUICK PLAY MATCHMAKING ──────────────────────────────────
 * Flow:
 *  1. Both players write to matchmaking/ and listen with child_added.
 *  2. Each tries to atomically claim the opponent via a transaction.
 *  3. Only ONE wins the transaction (removes opponent's entry).
 *  4. Winner (creator) writes full game room to games/ and starts it.
 *  5. Loser watches their OWN matchmaking entry — when it disappears
 *     (removed by the winner's transaction) they scan games/ for the
 *     room that was created for them. No cross-user writes needed.
 * ─────────────────────────────────────────────────────────── */

let matchmakingListener    = null;
let quickPlayGameListener  = null;
let matchmakingPairsRef    = null;
let matchmakingPairsListener = null;
let activeMatchmakingRanked = false;
const QP_TIME_SECS         = 600;
const QP_QUEUE_MAX_AGE_MS  = 2 * 60 * 1000;

function isFreshMatchmakingEntry(entry, now = Date.now()) {
  if (!entry) return false;
  const joinedAt = Number(entry.joinedAtMs || entry.joinedAt || 0);
  return Number.isFinite(joinedAt) &&
         joinedAt >= now - QP_QUEUE_MAX_AGE_MS &&
         joinedAt <= now + 15000;
}

function matchmakingQueuePath(isRanked = activeMatchmakingRanked) {
  return isRanked ? 'matchmaking/ranked' : 'matchmaking';
}

function matchmakingPairsPath(isRanked = activeMatchmakingRanked) {
  return isRanked ? 'matchmakingPairs/ranked' : 'matchmakingPairs';
}

function findUnrankedMatch() {
  findMatch(false);
}

function findRankedMatch() {
  if (!currentUser) { openAuthModal('signup'); return; }
  if (currentUser.isAnonymous) {
    const msg = document.getElementById('rankedGuestMessage');
    if (msg) msg.style.display = 'block';
    alert('Create an account to play ranked games.');
    return;
  }
  findMatch(true);
}

function findMatch(isRanked = false) {
  if (!currentUser) { openAuthModal('signup'); return; }
  if (!db) return;
  if (isRanked && currentUser.isAnonymous) {
    alert('Create an account to play ranked games.');
    return;
  }

  const uid = currentUser.uid;
  activeMatchmakingRanked = isRanked;
  const queuePath = matchmakingQueuePath(isRanked);
  const pairsPath = matchmakingPairsPath(isRanked);

  document.getElementById('qpIdle').style.display           = 'none';
  document.getElementById('matchmakingStatus').style.display = 'flex';
  document.getElementById('matchmakingText').textContent    = isRanked ? 'Searching for a ranked opponent…' : 'Searching for an opponent…';

  const ensureUsername = currentUsername
    ? Promise.resolve(currentUsername)
    : db.ref(`users/${uid}/username`).once('value').then(s => {
        const name = s.val() || 'Player';
        currentUsername = name;
        return name;
      });

  ensureUsername.then(async myUsername => {
    const myElo = isRanked ? await ensureUserElo(myUsername) : null;
    const myRef     = db.ref(`${queuePath}/${uid}`);
    const myPairRef = db.ref(`${pairsPath}/${uid}`);
    const searchStartedAt = Date.now();
    const sessionId = `${uid}_${searchStartedAt}_${Math.random().toString(36).slice(2, 8)}`;

    await myPairRef.remove().catch(() => {});
    await myRef.remove().catch(() => {});
    await db.ref(`matchmakingPairs/ranked/${uid}`).remove().catch(() => {});
    await db.ref(`matchmaking/ranked/${uid}`).remove().catch(() => {});
    if (isRanked) {
      await db.ref(`matchmakingPairs/${uid}`).remove().catch(() => {});
      await db.ref(`matchmaking/${uid}`).remove().catch(() => {});
    }
    await myRef.set({
      username: myUsername,
      ranked: isRanked,
      elo: myElo,
      joinedAt: firebase.database.ServerValue.TIMESTAMP,
      joinedAtMs: searchStartedAt,
      sessionId
    });
    myRef.onDisconnect().remove();
    myPairRef.onDisconnect().remove();
    matchmakingPairsRef = myPairRef;

    let paired = false;

    const joinMatchedQuickPlayGame = async code => {
      const gameSnap = await db.ref(`games/${code}`).once('value');
      if (!gameSnap.exists()) throw new Error('Matched game was not found.');

      const gameData = gameSnap.val();
      const colors   = gameData.colors || {};
      const names    = gameData.usernames || {};

      currentGameRanked = gameData.ranked === true;
      currentGameElos   = gameData.playerElos || {};
      myColor          = colors[uid] || (gameData.players?.host === uid ? 'b' : 'w');
      isFlipped = shouldAutoFlipForBlack(myColor);
      gameMode         = 'friend';
      friendJoinCode   = code;
      playerId         = uid;
      hostUsername     = sanitizePlayerName(names.host, 'Player');
      joinerUsername   = sanitizePlayerName(names.joiner, currentUsername || 'Player');
      opponentUsername = myColor === 'w' ? hostUsername : joinerUsername;

      // Register this player's slot in Firebase so security rules allow their moves.
      // The creator already wrote host; the joiner (non-creator) must write joiner slot.
      const mySlotInGame = gameData.players?.host === uid ? 'host' : 'joiner';
      if (mySlotInGame === 'joiner' && !gameData.players?.joiner) {
        const slotUpdates = {};
        slotUpdates[`games/${code}/players/joiner`]     = uid;
        slotUpdates[`games/${code}/usernames/joiner`]   = sanitizePlayerName(currentUsername || 'Player');
        slotUpdates[`games/${code}/colors/${uid}`]      = myColor;
        if (currentGameRanked && myElo != null) slotUpdates[`games/${code}/playerElos/${uid}`] = myElo;
        await db.ref().update(slotUpdates);
      }

      document.getElementById('matchmakingText').textContent = 'Found opponent! Loading…';
      document.getElementById('friendModal').style.display   = 'none';
      setupGameListener(code, true);
    };

    matchmakingPairsListener = myPairRef.on('value', async snap => {
      if (!snap.exists() || paired) return;

      const pairData = snap.val() || {};
      if (!pairData.code) return;

      paired = true;
      stopMatchmakingListener();

      try {
        await myPairRef.remove();
        await joinMatchedQuickPlayGame(pairData.code);
      } catch (err) {
        console.error('Quick play match handoff failed:', err);
        paired = false;
        document.getElementById('matchmakingStatus').style.display = 'none';
        document.getElementById('qpIdle').style.display            = 'grid';
      }
    }, handleMatchmakingError);

    // ── Try to claim an opponent from the queue ──
    const tryPair = async snap => {
      if (paired) return;
      if (!snap.exists()) return;
      const opponentUid = snap.key;
      if (opponentUid === uid) return;

      // Save opponent data NOW before the transaction wipes it
      const opponentData = snap.val() || {};
      const opponentName = opponentData.username || null;
      if (!isFreshMatchmakingEntry(opponentData)) return;

      paired = true; // claim synchronously before any await

      let result;
      try {
        const claimStartedAt = Date.now();
        result = await db.ref(`${queuePath}/${opponentUid}`).transaction(current => {
          if (current === null) return; // already gone
          if (!isFreshMatchmakingEntry(current, claimStartedAt)) return;
          return null;                  // claim it
        });
      } catch (e) { paired = false; return; }

      if (!result.committed) { paired = false; return; }

      // Use the name we captured from the snapshot (transaction result loses original data)
      // Fall back to fetching from DB if the queue entry had no username
      let resolvedOpponentName = opponentName;
      if (!resolvedOpponentName) {
        try {
          const nameSnap = await db.ref(`users/${opponentUid}/username`).once('value');
          resolvedOpponentName = nameSnap.val() || 'Guest';
        } catch (_) {
          resolvedOpponentName = 'Guest';
        }
      }

      await myRef.remove();
      stopMatchmakingListener();

      // Assign colors by UID sort — deterministic, same on both sides
      const iAmBlack = uid < opponentUid;
      const opponentElo = isRanked ? normalizeElo(opponentData.elo) : null;
      myColor        = iAmBlack ? 'b' : 'w';
      isFlipped = shouldAutoFlipForBlack(myColor);
      gameMode       = 'friend';
      playerId       = uid;
      friendJoinCode = generateJoinCode();
      hostUsername   = iAmBlack ? myUsername             : resolvedOpponentName;
      joinerUsername = iAmBlack ? resolvedOpponentName   : myUsername;

      const gameData = {
        players:     { host:   iAmBlack ? uid         : opponentUid,
                       joiner: iAmBlack ? opponentUid : uid },
        usernames:   { host:   iAmBlack ? sanitizePlayerName(myUsername)           : sanitizePlayerName(resolvedOpponentName),
                       joiner: iAmBlack ? sanitizePlayerName(resolvedOpponentName) : sanitizePlayerName(myUsername) },
        colors:      { [uid]: myColor, [opponentUid]: iAmBlack ? 'w' : 'b' },
        hostColor:   'b',
        timeControl: QP_TIME_SECS,
        board:       boardToFirebase(INITIAL_BOARD),
        currentTurn: 'w',
        moveHistory: [],
        gameOver:    false,
        lastMove:    null,
        enPassantSq: null,
        castlingRights: { wK: true, wQ: true, bK: true, bQ: true },
        capturedByWhite: [],
        capturedByBlack: [],
        halfMoveClock: 0,
        timerWhiteSecs: QP_TIME_SECS,
        timerBlackSecs: QP_TIME_SECS,
        timerLimitSecs: QP_TIME_SECS,
        quickPlay:   true,
        ranked:      isRanked,
        matchType:   isRanked ? 'ranked' : 'unranked',
        playerElos:  isRanked ? { [uid]: myElo, [opponentUid]: opponentElo } : null,
        createdAt:   firebase.database.ServerValue.TIMESTAMP
      };

      currentGameRanked = isRanked;
      currentGameElos = gameData.playerElos || {};
      await db.ref(`games/${friendJoinCode}`).set(gameData);
      await db.ref(`${pairsPath}/${opponentUid}`).set({
        code: friendJoinCode,
        opponentUid: uid,
        ranked: isRanked,
        createdAt: firebase.database.ServerValue.TIMESTAMP
      });

      document.getElementById('matchmakingText').textContent = `Found ${resolvedOpponentName}! Loading…`;
      document.getElementById('friendModal').style.display   = 'none';
      setupGameListener(friendJoinCode, true);
    };

    matchmakingListener = db.ref(queuePath)
      .orderByChild('joinedAt')
      .on('child_added', snap => tryPair(snap), handleMatchmakingError);

    db.ref(queuePath).orderByChild('joinedAt').once('value').then(queueSnap => {
      queueSnap.forEach(childSnap => {
        tryPair(childSnap);
      });
    }).catch(handleMatchmakingError);

    // ── Watch our OWN entry — when it disappears we were claimed ──
    quickPlayGameListener = myRef.on('value', async snap => {
      if (snap.exists()) return; // still in queue
      if (paired) return;
      document.getElementById('matchmakingText').textContent = 'Match found! Finalizing game…';
    }, handleMatchmakingError);
  }).catch(handleMatchmakingError);
}

function handleMatchmakingError(err) {
  console.error('Matchmaking failed:', err);
  if (currentUser && db) {
    db.ref(`matchmaking/${currentUser.uid}`).remove().catch(() => {});
    db.ref(`matchmakingPairs/${currentUser.uid}`).remove().catch(() => {});
    db.ref(`matchmaking/ranked/${currentUser.uid}`).remove().catch(() => {});
    db.ref(`matchmakingPairs/ranked/${currentUser.uid}`).remove().catch(() => {});
  }
  stopMatchmakingListener();
  const status = document.getElementById('matchmakingStatus');
  const idle = document.getElementById('qpIdle');
  const text = document.getElementById('matchmakingText');
  if (text) text.textContent = 'Unable to search right now. Please try again.';
  if (status) status.style.display = 'none';
  if (idle) idle.style.display = 'grid';
  alert('Unable to search for a match right now. Please try again.');
}


function stopMatchmakingListener() {
  const queuePath = matchmakingQueuePath();
  if (matchmakingListener) {
    db.ref(queuePath).orderByChild('joinedAt').off('child_added', matchmakingListener);
    matchmakingListener = null;
  }
  // quickPlayGameListener is a .on('value') on the player's own matchmaking entry
  if (quickPlayGameListener && currentUser) {
    db.ref(`${queuePath}/${currentUser.uid}`).off('value', quickPlayGameListener);
    quickPlayGameListener = null;
  }
  if (matchmakingPairsRef && matchmakingPairsListener) {
    matchmakingPairsRef.off('value', matchmakingPairsListener);
  }
  matchmakingPairsRef      = null;
  matchmakingPairsListener = null;
}

function cancelMatchmaking() {
  if (!db || !currentUser) return;
  stopMatchmakingListener();
  db.ref(`matchmaking/${currentUser.uid}`).remove();
  db.ref(`matchmakingPairs/${currentUser.uid}`).remove();
  db.ref(`matchmaking/ranked/${currentUser.uid}`).remove();
  db.ref(`matchmakingPairs/ranked/${currentUser.uid}`).remove();
  document.getElementById('matchmakingStatus').style.display = 'none';
  document.getElementById('qpIdle').style.display            = 'grid';
}

/** Leaderboards — stub modal */
async function openLeaderboardsModal() {
  closeModal('friendModal');
  if (currentUser && !currentUser.isAnonymous) {
    publishLeaderboardStats().catch(err => console.warn('Unable to publish leaderboard stats:', err));
  }
  const modal = document.getElementById('leaderboardsModal');
  if (modal) modal.style.display = 'flex';
  await loadLeaderboard();
}

/** Profile — reuses the existing account modal for now */
function openProfileModal() {
  closeModal('friendModal');
  if (!currentUser) { openAuthModal('signup'); return; }
  openStatsModal();
}

async function loadLeaderboard() {
  const list = document.getElementById('leaderboardList');
  const select = document.getElementById('leaderboardCategory');
  if (!list || !select || !db) return;

  const category = select.value || 'elo';
  const labels = {
    elo: 'Elo',
    wins: 'wins',
    losses: 'losses',
    winRate: '%'
  };

  list.innerHTML = '<p class="friends-empty">Loading leaderboard...</p>';

  try {
    const rows = await loadAllAccountLeaderboardRows();
    rows.sort((a, b) => (Number(b[category]) || 0) - (Number(a[category]) || 0));

    const topRows = fillLeaderboardRows(rows, 5);
    list.innerHTML = topRows.map((row, idx) => {
      const value = category === 'winRate'
        ? `${Number(row.winRate || 0).toFixed(1)}%`
        : category === 'elo'
        ? `${normalizeElo(row.elo)} Elo`
        : `${Number(row[category]) || 0} ${labels[category]}`;
      return `
        <div class="leaderboard-row">
          <span class="leaderboard-rank">#${idx + 1}</span>
          <span class="leaderboard-name">${sanitizePlayerName(row.username, 'Player')}</span>
          <span class="leaderboard-value">${value}</span>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error('Leaderboard load failed:', err);
    list.innerHTML = '<p class="friends-empty">Unable to load leaderboards right now.</p>';
  }
}

async function loadHomepageLeaderboardPreview() {
  const list = document.getElementById('homeLeaderboardPreview');
  if (!list || !db) return;

  try {
    const rows = await loadAllAccountLeaderboardRows();
    rows.sort((a, b) => (Number(b.wins) || 0) - (Number(a.wins) || 0));
    const topRows = fillLeaderboardRows(rows, 3);
    list.innerHTML = topRows.map((row, idx) => `
      <div class="leaderboard-row">
        <span class="leaderboard-rank">#${idx + 1}</span>
        <span class="leaderboard-name">${sanitizePlayerName(row.username, 'Player')}</span>
        <span class="leaderboard-value">${Number(row.wins) || 0} wins</span>
      </div>
    `).join('');
  } catch (err) {
    console.warn('Homepage leaderboard preview failed:', err);
  }
}

function fillLeaderboardRows(rows, count) {
  const filled = rows.slice(0, count);
  while (filled.length < count) {
    filled.push({
      uid: `placeholder_${filled.length + 1}`,
      username: 'Player',
      elo: STARTING_ELO,
      wins: 0,
      losses: 0,
      winRate: 0,
      onlineMatches: 0
    });
  }
  return filled;
}

async function loadAllAccountLeaderboardRows() {
  const usernameSnap = await db.ref('usernames').once('value');
  const usernames = usernameSnap.val() || {};
  const entries = Object.entries(usernames);

  const rows = await Promise.all(entries.map(async ([username, uid]) => {
    try {
      const statsSnap = await db.ref(`users/${uid}/stats`).once('value');
      const stats = { ...emptyStats(), ...(statsSnap.val() || {}) };
      const wins = Number(stats.wins) || 0;
      const losses = Number(stats.losses) || 0;
      const decisiveGames = wins + losses;
      return {
        uid,
        username,
        elo: normalizeElo(stats.elo),
        wins,
        losses,
        winRate: decisiveGames > 0 ? Math.round((wins / decisiveGames) * 10000) / 100 : 0,
        onlineMatches: Number(stats.onlineMatches) || 0
      };
    } catch (_) {
      return {
        uid,
        username,
        elo: STARTING_ELO,
        wins: 0,
        losses: 0,
        winRate: 0,
        onlineMatches: 0
      };
    }
  }));

  return rows.filter(row => row.username && !String(row.username).startsWith('guest_'));
}

function createFriendGame() {
  if (!db) { alert('Firebase not initialized. Please refresh the page.'); return; }
  if (!currentUser) { openAuthModal('signup'); return; }

  // Resolve color: random picks w or b at equal probability
  let resolvedColor = createColorChoice;
  if (resolvedColor === 'r') {
    resolvedColor = Math.random() < 0.5 ? 'b' : 'w';
  }

  // Read time control from the selector
  const tcSelect = document.getElementById('createTimeControl');
  const tcSecs   = tcSelect ? parseInt(tcSelect.value) : 600;

  playerId       = currentUser.uid;
  friendJoinCode = generateJoinCode();
  myColor        = resolvedColor;
  isFlipped = shouldAutoFlipForBlack(resolvedColor); // host's pieces at the bottom
  gameMode       = 'friend';
  hostUsername   = currentUsername;

  const gameData = {
    players:        { host: playerId },
    usernames:      { host: sanitizePlayerName(currentUsername) },
    colors:         { [playerId]: resolvedColor },
    hostColor:      resolvedColor,               // so joiner knows they get the opposite
    timeControl:    tcSecs,
    board:          boardToFirebase(INITIAL_BOARD),
    currentTurn:    'w',
    moveHistory:    [],
    gameOver:       false,
    lastMove:       null,
    enPassantSq:    null,
    castlingRights: { wK: true, wQ: true, bK: true, bQ: true },
    capturedByWhite: [],
    capturedByBlack: [],
    halfMoveClock:  0,
    timerWhiteSecs: tcSecs,
    timerBlackSecs: tcSecs,
    timerLimitSecs: tcSecs,
    ranked:         false,
    matchType:      'friend',
    createdAt:      firebase.database.ServerValue.TIMESTAMP
  };

  db.ref(`games/${friendJoinCode}`).set(gameData).then(() => {
    document.getElementById('joinCodeBox').textContent = friendJoinCode;
    document.getElementById('joinCodeDisplay').style.display = 'block';
    const wMsg = document.getElementById('waitingMsg');
    if (wMsg) wMsg.style.display = 'block';    setupGameListener(friendJoinCode, false);
  }).catch(err => {
    alert('Error creating game: ' + err.message);
  });
}

function joinFriendGame() {
  if (!db) { alert('Firebase not initialized. Please refresh the page.'); return; }
  if (!currentUser) { openAuthModal('signup'); return; }

  const code    = document.getElementById('friendJoinCode').value.trim();
  const errorEl = document.getElementById('joinError');

  if (code.length !== 4 || !/^\d+$/.test(code)) {
    errorEl.textContent = 'Please enter a valid 4-digit code';
    errorEl.style.display = 'block';
    return;
  }

  db.ref(`games/${code}`).once('value').then(snapshot => {
    if (!snapshot.exists()) {
      errorEl.textContent = 'Game not found. Check your code.';
      errorEl.style.display = 'block';
      return;
    }

    const gameData = snapshot.val();
    if (gameData.players && Object.keys(gameData.players).length >= 2) {
      errorEl.textContent = "Game is full. Can't join.";
      errorEl.style.display = 'block';
      return;
    }

    playerId       = currentUser.uid;
    friendJoinCode = code;
    // Joiner gets the opposite color of the host
    const hostColor   = gameData.hostColor || 'b';
    const joinerColor = hostColor === 'b' ? 'w' : 'b';
    myColor        = joinerColor;
    isFlipped = shouldAutoFlipForBlack(joinerColor); // joiner's pieces at the bottom
    gameMode       = 'friend';
    joinerUsername = sanitizePlayerName(currentUsername);
    hostUsername   = playerNameForSlot(gameData, 'host', 'Player');

    const updates = {};
    updates[`games/${code}/players/joiner`]          = playerId;
    updates[`games/${code}/usernames/joiner`]        = sanitizePlayerName(currentUsername);
    updates[`games/${code}/colors/${playerId}`]      = joinerColor;

    db.ref().update(updates).then(() => {
      closeModal('friendModal');
      setupGameListener(friendJoinCode, true);
    }).catch(err => {
      console.error('Join game failed:', err);
      errorEl.textContent = 'Unable to join this game right now. Please try again.';
      errorEl.style.display = 'block';
    });
  });
}

function setupGameListener(code, closeOnStart) {
  if (!db) { console.error('Firebase not initialized'); return; }
  console.log(`[SETUP] called — code=${code} myColor=${myColor} closeOnStart=${closeOnStart}`);

  const previousRef = friendGameRef;
  if (gameListener && previousRef) { console.log('[SETUP] detaching old listener'); previousRef.off('value', gameListener); }
  stopGameSyncPoller();
  detachGameFieldListeners();
  friendGameRef = db.ref(`games/${code}`);
  console.log('[SETUP] listening on:', friendGameRef.toString());

  // Capture myColor at the time the listener is set up so async Firebase
  // callbacks always use the correct value, even if the global is later changed.
  const localMyColor = myColor;

  let gameStarted = false;
  let lastProcessedSignature = null;

  const processGameSnapshot = snapshot => {
    if (!snapshot.exists()) return;

    const gameData    = snapshot.val();
    const playerCount = gameData.players ? Object.keys(gameData.players).length : 1;
    const signature   = gameSnapshotSignature(gameData);

    console.log(`[SNAP] fired — gameStarted=${gameStarted} turn=${gameData.currentTurn} dupSig=${gameStarted && signature === lastProcessedSignature}`);
    if (gameStarted && signature === lastProcessedSignature && onlineReviewIndex !== null) {
      console.log('[SNAP] skipped — duplicate while reviewing previous board');
      return;
    }
    if (gameStarted && signature === lastProcessedSignature && !needsApplyGameState(gameData)) {
      console.log('[SNAP] skipped — duplicate signature');
      return;
    }
    if (gameStarted && signature === lastProcessedSignature && needsApplyGameState(gameData)) {
      console.log('[SNAP] forcing apply — local state behind Firebase');
    }

    syncLocalNamesFromGame(gameData);
    mirrorInGameFriendRequests(gameData);
    mirrorInGameFriendAccepts(gameData);
    mirrorInGameFriendRemovals(gameData);
    recordOnlineGameStatsIfNeeded(gameData);
    handleDrawOfferSnapshot(gameData);

    // ── Waiting for second player ──
    if (!gameStarted) {
      if (!closeOnStart && playerCount < 2) return;

      lastProcessedSignature = signature;
      gameStarted = true;
      onlinePositionSnapshots = [];
      onlineReviewIndex = null;
      onlineLiveSnapshot = null;
      // Hide the modal directly — avoids closeModal() triggering cancelMatchmaking()
      const fModal = document.getElementById('friendModal');
      if (fModal) fModal.style.display = 'none';
      showGamePage();

      // White (joiner): isFlipped = false → white at bottom
      // Black (host):   isFlipped = true  → black at bottom
      isFlipped = shouldAutoFlipForBlack(localMyColor);

      // Write our own username into the game data so the opponent can read it.
      const mySlot = playerSlotForUid(gameData, currentUser?.uid) || (localMyColor === 'b' ? 'host' : 'joiner');
      if (currentUsername && friendGameRef) {
        friendGameRef.child(`usernames/${mySlot}`).set(sanitizePlayerName(currentUsername));
      }

      if (mySlot === 'host' && currentUsername) hostUsername = sanitizePlayerName(currentUsername);
      if (mySlot === 'joiner' && currentUsername) joinerUsername = sanitizePlayerName(currentUsername);
      syncLocalNamesFromGame({
        ...gameData,
        usernames: {
          ...(gameData.usernames || {}),
          [mySlot]: sanitizePlayerName(currentUsername)
        }
      });

      // Apply time control from game data (quick play sets this to 600)
      if (gameData.timeControl != null) {
        timerLimitSecs  = gameData.timeControl;
        timerWhiteSecs  = gameData.timeControl;
        timerBlackSecs  = gameData.timeControl;
      }

      gameMode = 'friend';
      initGame();      // resets board state and renders
      rememberOnlinePositionSnapshot();
      applySyncedGameState(gameData);
      renderBoard();
      renderMoveHistory();
      updateCapturedPieces();
      updateGameInfo();
      showInGameChat();
      // Auto-start timers for timed games
      if (timerLimitSecs > 0) startTimers();
      return;
    }

    lastProcessedSignature = signature;

    // ── In-progress: apply opponent's move ──
    console.log(`[SNAP] in-progress — Firebase turn: ${gameData.currentTurn}, myColor: ${myColor}`);
    if (!applySyncedGameState(gameData)) { console.error("[SNAP] invalid board"); return; }

    // ── Rematch accepted: game was reset — close modal and restart ──
    if (!gameData.gameOver && !gameData.gameOverTitle) {
      const modalOpen = document.getElementById('gameOverModal').style.display !== 'none';
      if (modalOpen) {
        closeModal('gameOverModal');
        activeGameOverModalKey = null;
        dismissedGameOverKeys = new Set();
        isFlipped = shouldAutoFlipForBlack(localMyColor);
        initGame();
        updateGameInfo();
        return;
      }
    }

    renderBoard();
    renderMoveHistory();
    updateStatusBar();
    updateCapturedPieces();
    updateGameInfo();
    updateTimerActiveState();
    if (gameData.gameOver && gameData.gameOverTitle) {
      const modalAlreadyOpen = document.getElementById('gameOverModal').style.display !== 'none';
      const gameOverKey = onlineGameOverKey(gameData);
      if (modalAlreadyOpen && gameOverKey && !activeGameOverModalKey) {
        activeGameOverModalKey = gameOverKey;
      }
      const shouldReplaceDrawOffer = gameData.gameOverReason === 'agreedDraw' && (drawOfferModalKey || modalAlreadyOpen);
      if (dismissedGameOverKeys.has(gameOverKey) && !shouldReplaceDrawOffer) {
        stopTimers();
        return;
      }
      if (!modalAlreadyOpen || shouldReplaceDrawOffer) {
        drawOfferModalKey = null;
        // Opponent triggered game over — show modal on our screen too
        const rematchPending = !!(gameData.rematchRequest && gameData.rematchRequest !== currentUser?.uid);
        showGameOverModal(
          gameData.gameOverTitle,
          gameData.gameOverSub   || '',
          gameData.gameOverIcon  || '♚',
          rematchPending,
          gameOverKey
        );
        stopTimers();
      } else if (gameData.rematchRequest && gameData.rematchRequest !== currentUser?.uid) {
        // Modal is already open — just flip the button to "Accept Rematch"
        const rematchBtn = document.getElementById('rematchBtn');
        if (rematchBtn && rematchBtn.style.display !== 'none') {
          rematchBtn.textContent = 'Accept Rematch';
          rematchBtn.onclick = acceptRematch;
        }
      }
    }
  };

  console.log('[SETUP] attaching .on(value) listener');
  gameListener = friendGameRef.on('value', processGameSnapshot);
  console.log('[SETUP] listener attached, gameListener=', !!gameListener);

  // Dedicated listeners on turn / moveHistory — backup when the root value event is missed
  const onRemoteFieldChange = () => {
    if (!friendGameRef) return;
    clearTimeout(gameFieldDebounceId);
    gameFieldDebounceId = setTimeout(() => {
      friendGameRef.once('value').then(processGameSnapshot).catch(err => {
        console.error('[SNAP] field listener fetch failed:', err);
      });
    }, 50);
  };
  const turnRef = friendGameRef.child('currentTurn');
  turnRef.on('value', onRemoteFieldChange);
  gameFieldListeners.push({ ref: turnRef, event: 'value', handler: onRemoteFieldChange });
  const histRef = friendGameRef.child('moveHistory');
  histRef.on('child_added', onRemoteFieldChange);
  gameFieldListeners.push({ ref: histRef, event: 'child_added', handler: onRemoteFieldChange });

  gameSyncPollId = setInterval(() => {
    if (!friendGameRef || gameMode !== 'friend') return;
    friendGameRef.once('value').then(processGameSnapshot).catch(err => {
      console.error('Game sync poll failed:', err);
    });
  }, 1000);
}

function syncMoveToFriend(notation) {
  if (!db) { console.warn('[SYNC] no db'); return; }
  if (!friendGameRef) { console.warn('[SYNC] no friendGameRef'); return; }
  if (gameMode !== 'friend') { console.warn('[SYNC] gameMode is', gameMode); return; }

  // finishMove() calls this only after a local move has been executed and the
  // turn has switched. Do not let a stale color value silently drop the move.
  const movedColor = currentTurn === 'w' ? 'b' : 'w';
  if (myColor && myColor !== movedColor) {
    console.warn(`[SYNC] color mismatch — myColor=${myColor}, movedColor=${movedColor}; syncing local move anyway`);
  }

  const updates = gameStateForFirebase();
  console.log('[SYNC] writing to Firebase, currentTurn in payload:', updates.currentTurn);

  friendGameRef.update(updates).then(() => {
    console.log('[SYNC] success ✓');
  }).catch(err => {
    console.error('[SYNC] FAILED — Firebase rejected write:', err.code, err.message);
  });
}

function exitFriendGame() {
  if (gameListener && friendGameRef) {
    friendGameRef.off('value', gameListener);
  }
  stopGameSyncPoller();
  detachGameFieldListeners();
  hideInGameChat();
  friendJoinCode   = null;
  playerId         = null;
  gameListener     = null;
  myColor          = null;
  gameMode         = 'pvp';
  hostUsername     = null;
  joinerUsername   = null;
  opponentUsername = null;
  onlinePlayerUidByColor = { w: null, b: null };
  currentGameRanked = false;
  currentGameElos = {};
  currentDrawOffer = null;
  handledDrawOffers = new Set();
  drawOfferModalKey = null;
  currentGameFriendRequests = {};
  currentGameFriendAccepts = {};
  currentGameFriendRemovals = {};
  mirroredInGameFriendRequests = new Set();
  mirroredInGameFriendAccepts = new Set();
  mirroredInGameFriendRemovals = new Set();
  onlinePositionSnapshots = [];
  onlineReviewIndex = null;
  onlineLiveSnapshot = null;
  updateOnlineReviewControls();
  newGame();
}

/* ══════════════════════════════════════════
   REMATCH SYSTEM
══════════════════════════════════════════ */

function requestRematch() {
  if (!friendGameRef || !currentUser) return;
  // Don't close the modal — just update the button to show we're waiting
  const rematchBtn = document.getElementById('rematchBtn');
  if (rematchBtn) {
    rematchBtn.textContent = 'Waiting for opponent…';
    rematchBtn.disabled    = true;
  }
  friendGameRef.update({ rematchRequest: currentUser.uid });
}

function acceptRematch() {
  if (!friendGameRef) return;
  // Clear the rematch request and reset game state in Firebase
  const resetData = {
    board:          boardToFirebase(INITIAL_BOARD),
    currentTurn:    'w',
    moveHistory:    [],
    gameOver:       false,
    gameOverTitle:  null,
    gameOverSub:    null,
    gameOverIcon:   null,
    gameOverReason: null,
    gameOverWinner: null,
    rematchRequest: null,
    drawOffer:      null,
    lastMove:       null,
    enPassantSq:    null,
    castlingRights: { wK: true, wQ: true, bK: true, bQ: true },
    capturedByWhite: [],
    capturedByBlack: [],
    halfMoveClock:  0,
    timerWhiteSecs: timerLimitSecs,
    timerBlackSecs: timerLimitSecs,
    timerLimitSecs: timerLimitSecs,
    createdAt:      firebase.database.ServerValue.TIMESTAMP
  };
  friendGameRef.update(resetData).then(() => {
    closeModal('gameOverModal');
    isFlipped = shouldAutoFlipForBlack(myColor);
    initGame();
    updateGameInfo();
  });
}

function declineRematch() {
  if (friendGameRef) friendGameRef.update({ rematchRequest: null });
  // Re-enable the request button in case they want to request instead
  const rematchBtn = document.getElementById('rematchBtn');
  if (rematchBtn) {
    rematchBtn.textContent = 'Request Rematch';
    rematchBtn.onclick     = requestRematch;
    rematchBtn.disabled    = false;
  }
}

function copyJoinCode() {
  const code = document.getElementById('joinCodeBox').textContent;
  navigator.clipboard.writeText(code).then(() => {
    alert('Join code copied to clipboard!');
  });
}

/* ══════════════════════════════════════════
   CLOSE MODALS ON OVERLAY CLICK
══════════════════════════════════════════ */
['gameOverModal', 'friendModal'].forEach(id => {
  document.getElementById(id)?.addEventListener('click', function(e) {
    if (e.target === this && id !== 'friendModal') closeModal(id);
  });
});

/* ══════════════════════════════════════════
   START
══════════════════════════════════════════ */
// Generate a unique player ID
playerId = generatePlayerId();

// Load saved display, sound, timer and gameplay preferences before drawing the board.
loadUserSettings();

// Initialize the game
initGame();

// Initialize Firebase asynchronously with retries
function initFirebaseWithRetry(attempts = 0) {
  if (typeof firebase !== 'undefined' && firebase.apps) {
    initFirebase();
    console.log('Firebase initialized successfully');
    loadHomepageLeaderboardPreview();
  } else if (attempts < 10) {
    setTimeout(() => initFirebaseWithRetry(attempts + 1), 500);
  } else {
    console.error('Firebase SDK failed to load after 10 attempts');
  }
}

// Wait for Firebase SDK to be available
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initFirebaseWithRetry();
  });
} else {
  initFirebaseWithRetry();
}
