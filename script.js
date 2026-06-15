/* ═══════════════════════════════════════════════════════════
   DigiChess.com — script.js
   Full chess rules + UI logic
   Architecture allows easy Stockfish AI integration later.
═══════════════════════════════════════════════════════════ */

/* ── GAME MODE ── (change to 'ai' for future Stockfish support) */
let gameMode = "pvp"; // "pvp" | "ai" | "friend"

/* ── FIREBASE CONFIG (will initialize after SDK loads) ── */
let db = null;

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
      currentUser = user;
      if (user) {
        // Logged in — fetch username from DB and update UI
        db.ref(`users/${user.uid}/username`).once('value').then(snap => {
          const username = snap.val() || 'Player';
          currentUsername = username;
          updateAccountUI(username);
        });
      } else {
        currentUsername = null;
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
let isFlipped    = true;        // board orientation (white at bottom)
let gameOver     = false;
let halfMoveClock = 0;          // for display

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

// Auth state
let currentUser     = null;        // Firebase Auth user object
let currentUsername = null;        // display username

// Friend game player names
let opponentUsername = null;       // the other player's username in a friend game
let hostUsername     = null;       // username of who created the game
let joinerUsername   = null;       // username of who joined the game

/* ══════════════════════════════════════════
   MULTIPLAYER HELPER FUNCTIONS (defined early)
══════════════════════════════════════════ */

function generatePlayerId() {
  return 'player_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
}

function generateJoinCode() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

function openFriendModal() {
  // Require login to play vs friend
  if (!currentUser) {
    openAuthModal('signup');
    return;
  }
  document.getElementById('friendModal').style.display = 'flex';
  document.getElementById('joinError').style.display = 'none';
  document.getElementById('joinCodeDisplay').style.display = 'none';
  document.getElementById('friendJoinCode').value = '';
  document.getElementById('waitingMsg') && (document.getElementById('waitingMsg').style.display = 'none');
}

/* ══════════════════════════════════════════
   INITIALIZATION
══════════════════════════════════════════ */
function initGame() {
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
}

function newGame() {
  closeModal('gameOverModal');
  stopTimers();
  resetTimers();
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
      if (lastMove) {
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
      const lm = legalMoves.find(m => m.row === dispRow && m.col === dispCol);
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

  // In online games, only allow moves on your own turn
  if (gameMode === 'friend' && myColor !== currentTurn) return;

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
function executeMove(fromRow, fromCol, toRow, toCol, special) {
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

  // ── AI HOOK ──
  // After a human move in AI mode, trigger the AI response.
  // Replace makeAIMove() body with Stockfish integration.
  if (gameMode === 'ai' && currentTurn === 'b' && !gameOver) {
    setTimeout(makeAIMove, 400);
  }
  
  // Sync to Firebase if playing with friend
  if (gameMode === 'friend') {
    syncMoveToFriend(notation);
  }
}

/* ══════════════════════════════════════════
   AI INTEGRATION HOOK
   Replace this function with Stockfish later
══════════════════════════════════════════ */
function makeAIMove() {
  // ──────────────────────────────────────────────────────────────
  // FUTURE STOCKFISH INTEGRATION:
  //
  // 1. Load stockfish.js web worker
  // 2. Send current position as FEN string: generateFEN()
  // 3. Receive best move in UCI format (e.g. "e2e4")
  // 4. Parse & call: executeMove(fromRow, fromCol, toRow, toCol)
  //
  // Example skeleton:
  //   const fen = generateFEN();
  //   stockfish.postMessage('position fen ' + fen);
  //   stockfish.postMessage('go movetime 1000');
  //   stockfish.onmessage = (e) => {
  //     if (e.data.startsWith('bestmove')) {
  //       const move = e.data.split(' ')[1]; // e.g. "d7d5"
  //       const from = algebraicToRowCol(move.slice(0,2));
  //       const to   = algebraicToRowCol(move.slice(2,4));
  //       executeMove(from.row, from.col, to.row, to.col);
  //     }
  //   };
  // ──────────────────────────────────────────────────────────────

  // Placeholder: pick a random legal move for black
  const allMoves = getAllLegalMovesForColor('b');
  if (allMoves.length === 0) return;
  const pick = allMoves[Math.floor(Math.random() * allMoves.length)];
  executeMove(pick.fromRow, pick.fromCol, pick.toRow, pick.toCol, pick.special);
}

/* Helper for AI placeholder */
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
function triggerGameOver(reason, lastNotation) {
  gameOver = true;
  stopTimers();

  const winner = currentTurn === 'w' ? 'Black' : 'White'; // who just moved wins

  let title = '', sub = '', icon = '♚';
  if (reason === 'checkmate') {
    title = `${winner} wins!`;
    sub   = `Checkmate — ${winner} delivers the final blow.`;
    icon  = winner === 'White' ? '♔' : '♚';
    playSound('checkmate');
  } else if (reason === 'stalemate') {
    title = 'Stalemate!';
    sub   = 'No legal moves — the game ends in a draw.';
    icon  = '♟';
  } else if (reason === 'resign') {
    title = `${winner} wins by resignation!`;
    sub   = `${currentTurn === 'w' ? 'White' : 'Black'} resigned the game.`;
    icon  = winner === 'White' ? '♔' : '♚';
  } else if (reason === 'timeout') {
    title = `${winner} wins on time!`;
    sub   = 'The clock ran out.';
    icon  = '⏱';
  }

  setTimeout(() => {
    document.getElementById('gameOverIcon').textContent  = icon;
    document.getElementById('gameOverTitle').textContent = title;
    document.getElementById('gameOverSub').textContent   = sub;
    document.getElementById('gameOverModal').style.display = 'flex';
    document.getElementById('infoStatus').textContent    = 'Ended';
    document.getElementById('infoStatus').className      = 'status-ended';
  }, 300);
}

/* ══════════════════════════════════════════
   UNDO
══════════════════════════════════════════ */
function undoMove() {
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
  updateCapturedPieces();
  updateGameInfo();
}

/* ══════════════════════════════════════════
   RESIGN
══════════════════════════════════════════ */
function resignGame() {
  if (gameOver) return;
  triggerGameOver('resign', '');
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
  if (!gameOver) {
    document.getElementById('infoStatus').textContent = 'Active';
    document.getElementById('infoStatus').className  = 'status-active';
  }

  // Player name rows in game info
  const playerNamesSection = document.getElementById('playerNamesSection');
  if (gameMode === 'friend' && hostUsername && joinerUsername) {
    // joiner = white (bottom), host = black (top)
    const whitePlayer = joinerUsername;
    const blackPlayer = hostUsername;
    const myName = currentUsername;
    const oppName = myColor === 'w' ? blackPlayer : whitePlayer;

    document.getElementById('infoWhitePlayer').textContent = whitePlayer;
    document.getElementById('infoBlackPlayer').textContent = blackPlayer;

    // Show add friend button next to opponent if not already friends
    const addBtnWhite = document.getElementById('addFriendWhite');
    const addBtnBlack = document.getElementById('addFriendBlack');
    if (addBtnWhite) addBtnWhite.style.display = (whitePlayer !== myName) ? 'inline-flex' : 'none';
    if (addBtnBlack) addBtnBlack.style.display = (blackPlayer !== myName) ? 'inline-flex' : 'none';

    if (playerNamesSection) playerNamesSection.style.display = 'block';
  } else {
    if (playerNamesSection) playerNamesSection.style.display = 'none';
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

    if (timerWhiteSecs <= 0) { timerWhiteSecs = 0; updateTimerDisplays(); triggerGameOver('timeout',''); return; }
    if (timerBlackSecs <= 0) { timerBlackSecs = 0; updateTimerDisplays(); triggerGameOver('timeout',''); return; }

    updateTimerDisplays();
  }, 1000);
  updateTimerActiveState();
}

function stopTimers() {
  timersRunning = false;
  clearInterval(timerInterval);
  timerInterval = null;
}

function resetTimers() {
  stopTimers();
  timerWhiteSecs = timerLimitSecs;
  timerBlackSecs = timerLimitSecs;
  updateTimerDisplays();
  updateTimerActiveState();
}

function changeTimerPreset() {
  const val = parseInt(document.getElementById('timerPreset').value);
  timerLimitSecs = val;
  resetTimers();
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
    openFriendModal();
    return;
  }
  
  if (mode === 'ai') {
    const banner = document.getElementById('aiBanner');
    banner.style.display = 'flex';
    return;
  }
  
  if (gameMode === 'friend') {
    exitFriendGame();
  }
  
  gameMode = mode;
  document.getElementById('btnPVP').classList.toggle('active', mode === 'pvp');
  document.getElementById('btnAI').classList.toggle('active',  mode === 'ai');
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
  document.getElementById(id).style.display = 'none';
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
  if (e.key === 'f') flipBoard();
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
    avatar.textContent  = username.charAt(0).toUpperCase();
    nameEl.textContent  = username;
    widget.style.display    = 'flex';
    signInBtn.style.display = 'none';
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
    // Check username is not taken
    const snap = await db.ref(`usernames/${username}`).once('value');
    if (snap.exists()) {
      showAuthError(errorEl, 'That username is already taken. Try another.');
      btn.disabled = false;
      btn.textContent = 'Sign Up';
      return;
    }

    // Create Firebase Auth account using username@digichess.com as internal email
    const email = `${username}@digichess.com`;
    const cred  = await firebase.auth().createUserWithEmailAndPassword(email, password);
    const uid   = cred.user.uid;

    // Store username in DB (both for lookup and reverse lookup)
    await db.ref(`users/${uid}/username`).set(username);
    await db.ref(`usernames/${username}`).set(uid);

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

function signOutUser() {
  firebase.auth().signOut().catch(err => console.error('Sign out error:', err));
}

/* ══════════════════════════════════════════
   ACCOUNT SETTINGS
══════════════════════════════════════════ */

function openAccountModal() {
  document.getElementById('profileDropdown').style.display = 'none';
  // Reset all fields and messages
  ['newUsernameInput','currentPasswordInput','newPasswordInput','confirmPasswordInput','deletePasswordInput']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  ['changeUsernameError','changeUsernameSuccess','changePasswordError','changePasswordSuccess','deleteAccountError']
    .forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
  ['changeUsernameBtn','changePasswordBtn','deleteAccountBtn']
    .forEach(id => { const el = document.getElementById(id); if (el) { el.disabled = false; el.textContent = { changeUsernameBtn:'Update Username', changePasswordBtn:'Update Password', deleteAccountBtn:'Delete My Account' }[id]; }});

  // Pre-fill current username hint
  const sub = document.getElementById('accountModalSub');
  if (sub) sub.textContent = `Signed in as: ${currentUsername}`;

  document.getElementById('accountModal').style.display = 'flex';
}

async function handleChangeUsername() {
  const newUsername = document.getElementById('newUsernameInput').value.trim().toLowerCase();
  const errorEl     = document.getElementById('changeUsernameError');
  const successEl   = document.getElementById('changeUsernameSuccess');
  const btn         = document.getElementById('changeUsernameBtn');

  errorEl.style.display = successEl.style.display = 'none';

  if (newUsername.length < 3) {
    return showAuthError(errorEl, 'Username must be at least 3 characters.');
  }
  if (!/^[a-z0-9_]+$/.test(newUsername)) {
    return showAuthError(errorEl, 'Only letters, numbers, and underscores allowed.');
  }
  if (newUsername === currentUsername) {
    return showAuthError(errorEl, 'That is already your username.');
  }

  btn.disabled = true;
  btn.textContent = 'Updating…';

  try {
    // Check availability
    const snap = await db.ref(`usernames/${newUsername}`).once('value');
    if (snap.exists()) {
      showAuthError(errorEl, 'That username is already taken.');
      btn.disabled = false; btn.textContent = 'Update Username';
      return;
    }

    const uid      = currentUser.uid;
    const oldUsername = currentUsername;
    const updates  = {};

    // Remove old username entry, add new one
    updates[`usernames/${oldUsername}`]    = null;
    updates[`usernames/${newUsername}`]    = uid;
    updates[`users/${uid}/username`]       = newUsername;
    // Update Firebase Auth email to match
    await firebase.auth().currentUser.updateEmail(`${newUsername}@digichess.com`);
    await db.ref().update(updates);

    currentUsername = newUsername;
    updateAccountUI(newUsername);

    successEl.textContent  = 'Username updated successfully!';
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
  const currentPw  = document.getElementById('currentPasswordInput').value;
  const newPw      = document.getElementById('newPasswordInput').value;
  const confirmPw  = document.getElementById('confirmPasswordInput').value;
  const errorEl    = document.getElementById('changePasswordError');
  const successEl  = document.getElementById('changePasswordSuccess');
  const btn        = document.getElementById('changePasswordBtn');

  errorEl.style.display = successEl.style.display = 'none';

  if (!currentPw) return showAuthError(errorEl, 'Enter your current password.');
  if (newPw.length < 6) return showAuthError(errorEl, 'New password must be at least 6 characters.');
  if (newPw !== confirmPw) return showAuthError(errorEl, 'New passwords do not match.');

  btn.disabled = true; btn.textContent = 'Updating…';

  try {
    // Re-authenticate first (Firebase requires this for sensitive ops)
    const email      = `${currentUsername}@digichess.com`;
    const credential = firebase.auth.EmailAuthProvider.credential(email, currentPw);
    await firebase.auth().currentUser.reauthenticateWithCredential(credential);
    await firebase.auth().currentUser.updatePassword(newPw);

    successEl.textContent  = 'Password updated successfully!';
    successEl.style.display = 'block';
    ['currentPasswordInput','newPasswordInput','confirmPasswordInput']
      .forEach(id => { document.getElementById(id).value = ''; });
  } catch (err) {
    console.error('Change password error:', err);
    showAuthError(errorEl, friendlyAuthError(err.code));
  }

  btn.disabled = false; btn.textContent = 'Update Password';
}

async function handleDeleteAccount() {
  const password = document.getElementById('deletePasswordInput').value;
  const errorEl  = document.getElementById('deleteAccountError');
  const btn      = document.getElementById('deleteAccountBtn');

  errorEl.style.display = 'none';

  if (!password) return showAuthError(errorEl, 'Enter your password to confirm deletion.');

  if (!confirm(`Are you sure you want to permanently delete your account "${currentUsername}"? This cannot be undone.`)) return;

  btn.disabled = true; btn.textContent = 'Deleting…';

  try {
    const email      = `${currentUsername}@digichess.com`;
    const credential = firebase.auth.EmailAuthProvider.credential(email, password);
    await firebase.auth().currentUser.reauthenticateWithCredential(credential);

    const uid = currentUser.uid;

    // Remove all user data from DB
    const updates = {};
    updates[`users/${uid}`]              = null;
    updates[`usernames/${currentUsername}`] = null;
    await db.ref().update(updates);

    // Delete Firebase Auth account
    await firebase.auth().currentUser.delete();

    closeModal('accountModal');
    // onAuthStateChanged will fire and update the UI automatically
  } catch (err) {
    console.error('Delete account error:', err);
    showAuthError(errorEl, friendlyAuthError(err.code));
    btn.disabled = false; btn.textContent = 'Delete My Account';
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
  document.getElementById('profileDropdown').style.display = 'none';
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
  if (friendUids.length === 0) {
    friendsList.innerHTML = '<p class="friends-empty">No friends yet. Add someone below!</p>';
  } else {
    for (const fuid of friendUids) {
      const nameSnap = await db.ref(`users/${fuid}/username`).once('value');
      const fname = nameSnap.val() || fuid;
      const row = document.createElement('div');
      row.className = 'friend-row';
      row.innerHTML = `
        <span class="friend-avatar">${fname.charAt(0).toUpperCase()}</span>
        <span class="friend-name">${fname}</span>
        <button class="btn btn-sm btn-ghost btn-danger-ghost" onclick="removeFriend('${fuid}','${fname}')">Remove</button>
      `;
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
    const nameSnap = await db.ref(`users/${ruid}/username`).once('value');
    const rname = nameSnap.val() || ruid;
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
  await db.ref(`users/${targetUid}/friendRequests/${myUid}`).set(true);

  successEl.textContent  = `Friend request sent to ${targetUsername}!`;
  successEl.style.display = 'block';
  input.value = '';
}

async function acceptFriendRequest(fromUid, fromName) {
  const myUid = currentUser.uid;
  const updates = {};
  // Add each other as friends
  updates[`users/${myUid}/friends/${fromUid}`]   = true;
  updates[`users/${fromUid}/friends/${myUid}`]   = true;
  // Remove the request
  updates[`users/${myUid}/friendRequests/${fromUid}`] = null;
  await db.ref().update(updates);
  loadFriendsModal(); // refresh
}

async function declineFriendRequest(fromUid) {
  await db.ref(`users/${currentUser.uid}/friendRequests/${fromUid}`).remove();
  loadFriendsModal();
}

async function removeFriend(fuid, fname) {
  if (!confirm(`Remove ${fname} from your friends?`)) return;
  const myUid = currentUser.uid;
  const updates = {};
  updates[`users/${myUid}/friends/${fuid}`]  = null;
  updates[`users/${fuid}/friends/${myUid}`]  = null;
  await db.ref().update(updates);
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
  await db.ref(`users/${targetUid}/friendRequests/${currentUser.uid}`).set(true);
  alert(`Friend request sent to ${username}!`);
}

/* ══════════════════════════════════════════
   ADDITIONAL MULTIPLAYER FUNCTIONS
══════════════════════════════════════════ */

// Firebase drops null values from arrays, so we encode null as "." for storage
function boardToFirebase(b) {
  return b.map(row => row.map(sq => sq === null ? '.' : sq));
}

function boardFromFirebase(raw) {
  // raw may be a plain object (Firebase converts arrays to objects keyed by index)
  const rows = Array.isArray(raw) ? raw : Object.keys(raw).sort((a,b) => Number(a)-Number(b)).map(k => raw[k]);
  return rows.map(row => {
    const cols = Array.isArray(row) ? row : Object.keys(row).sort((a,b) => Number(a)-Number(b)).map(k => row[k]);
    return cols.map(sq => (sq === '.' || sq === undefined || sq === null) ? null : sq);
  });
}

function createFriendGame() {
  if (!db) { alert('Firebase not initialized. Please refresh the page.'); return; }
  if (!currentUser) { openAuthModal('signup'); return; }

  playerId = currentUser.uid;
  friendJoinCode = generateJoinCode();
  myColor = 'b';   // host plays black
  gameMode = 'friend';
  hostUsername = currentUsername;

  const gameData = {
    players:     { host: playerId },
    usernames:   { host: currentUsername },
    colors:      { [playerId]: 'b' },
    board:       boardToFirebase(INITIAL_BOARD),
    currentTurn: 'w',
    moveHistory: [],
    gameOver:    false,
    createdAt:   firebase.database.ServerValue.TIMESTAMP
  };

  db.ref(`games/${friendJoinCode}`).set(gameData).then(() => {
    document.getElementById('joinCodeBox').textContent = friendJoinCode;
    document.getElementById('joinCodeDisplay').style.display = 'block';
    const wMsg = document.getElementById('waitingMsg');
    if (wMsg) wMsg.style.display = 'block';
    setupGameListener(friendJoinCode, false);
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
    myColor        = 'w';   // joiner plays white (bottom of board)
    gameMode       = 'friend';
    joinerUsername = currentUsername;
    hostUsername   = gameData.usernames ? gameData.usernames.host : 'Opponent';

    const updates = {};
    updates[`games/${code}/players/joiner`]          = playerId;
    updates[`games/${code}/usernames/joiner`]        = currentUsername;
    updates[`games/${code}/colors/${playerId}`]      = 'w';

    db.ref().update(updates).then(() => {
      closeModal('friendModal');
      setupGameListener(friendJoinCode, true);
    });
  });
}

function setupGameListener(code, closeOnStart) {
  if (!db) { console.error('Firebase not initialized'); return; }

  friendGameRef = db.ref(`games/${code}`);
  if (gameListener) friendGameRef.off('value', gameListener);

  let gameStarted = false;

  gameListener = friendGameRef.on('value', snapshot => {
    if (!snapshot.exists()) return;

    const gameData    = snapshot.val();
    const playerCount = gameData.players ? Object.keys(gameData.players).length : 1;

    // Sync usernames whenever available
    if (gameData.usernames) {
      hostUsername   = gameData.usernames.host   || hostUsername;
      joinerUsername = gameData.usernames.joiner || joinerUsername;
      opponentUsername = myColor === 'w' ? hostUsername : joinerUsername;
    }

    // ── Waiting for second player ──
    if (!gameStarted) {
      if (!closeOnStart && playerCount < 2) return;

      gameStarted = true;
      closeModal('friendModal');

      // White (joiner) has board normal (isFlipped = true = white at bottom)
      // Black (host)   has board flipped  (isFlipped = false = black at bottom)
      isFlipped = (myColor === 'w');

      gameMode = 'friend';
      initGame();      // resets board state and renders
      updateGameInfo();
      return;
    }

    // ── In-progress: apply opponent's move ──
    const parsedBoard = boardFromFirebase(gameData.board);
    if (!parsedBoard || parsedBoard.length !== 8 || parsedBoard.some(r => !r || r.length !== 8)) {
      console.error('Invalid board from Firebase:', parsedBoard);
      return;
    }

    board       = parsedBoard;
    currentTurn = gameData.currentTurn;
    moveHistory = Array.isArray(gameData.moveHistory)
      ? gameData.moveHistory
      : Object.values(gameData.moveHistory || {});
    gameOver    = gameData.gameOver;

    renderBoard();
    renderMoveHistory();
    updateStatusBar();
    updateGameInfo();
  });
}

function syncMoveToFriend(notation) {
  if (!db || !friendGameRef || gameMode !== 'friend') return;
  
  // Only sync after our own move (the turn just switched away from us)
  // myColor is the color we play — after our move, currentTurn flips to the other player
  const weJustMoved = (myColor === 'w' && currentTurn === 'b') || (myColor === 'b' && currentTurn === 'w');
  if (!weJustMoved) return;

  try {
    const updates = {
      board: boardToFirebase(board),
      currentTurn: currentTurn,
      moveHistory: moveHistory,
      gameOver: gameOver
    };
    
    friendGameRef.update(updates);
  } catch (err) {
    console.error('Error syncing move:', err);
  }
}

function exitFriendGame() {
  if (gameListener && friendGameRef) {
    friendGameRef.off('value', gameListener);
  }
  friendJoinCode   = null;
  playerId         = null;
  gameListener     = null;
  myColor          = null;
  gameMode         = 'pvp';
  hostUsername     = null;
  joinerUsername   = null;
  opponentUsername = null;
  newGame();
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

// Initialize the game
initGame();

// Initialize Firebase asynchronously with retries
function initFirebaseWithRetry(attempts = 0) {
  if (typeof firebase !== 'undefined' && firebase.apps) {
    initFirebase();
    console.log('Firebase initialized successfully');
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
