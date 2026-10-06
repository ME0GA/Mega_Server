const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
app.set('trust proxy', 1);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});
const musicFiles = new Map();

// إعدادات CORS للسماح بالاتصال من Flutter Web
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// مسار رئيسي للتأكد أن السيرفر شغال لما تفتحه في المتصفح
app.get('/', (req, res) => {
  res.send('🚀 Mega Server is running perfectly!');
});

app.post('/api/room-music', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Audio file is required' });

  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  musicFiles.set(id, {
    buffer: req.file.buffer,
    contentType: req.file.mimetype || 'audio/mpeg',
    name: req.file.originalname
  });

  const baseUrl = process.env.PUBLIC_SERVER_URL || `${req.protocol}://${req.get('host')}`;
  res.json({
    id,
    name: req.file.originalname,
    url: `${baseUrl}/room-music/${id}`
  });
});

app.get('/room-music/:id', (req, res) => {
  const music = musicFiles.get(req.params.id);
  if (!music) return res.status(404).send('Music file not found');
  res.set('Content-Type', music.contentType);
  res.set('Accept-Ranges', 'bytes');
  res.send(music.buffer);
});

const rooms = {};
const voiceRooms = {};

function generateUniqueRoomCode() {
  let roomCode = generateRoomCode();
  while (rooms[roomCode] || voiceRooms[roomCode]) {
    roomCode = generateRoomCode();
  }
  return roomCode;
}

function voiceRoomSnapshot(room) {
  return {
    roomCode: room.roomCode,
    roomName: room.roomName,
    roomType: room.roomType,
    maxMembers: room.maxMembers,
    isPublic: room.isPublic,
    music: room.music || null,
    members: room.members
  };
}

function emitVoiceRoomState(roomCode) {
  const room = voiceRooms[roomCode];
  if (room) {
    io.to(roomCode).emit('voiceRoomState', voiceRoomSnapshot(room));
  }
}

function generatePlayerId() {
  return Math.floor(10000000 + Math.random() * 90000000).toString();
}

// بنك أسئلة تجريبي لـ Quiz Game
const sampleQuestions = [
  {
    question: 'ما هي عاصمة مصر؟',
    options: ['الأسكندرية', 'القاهرة', 'الجيزة', 'أسوان'],
    correctIndex: 1
  },
  {
    question: 'ما هو الكوكب الملقب بالكوكب الأحمر؟',
    options: ['الزهرة', 'المشتري', 'المريخ', 'زحل'],
    correctIndex: 2
  },
  {
    question: 'كم عدد أضلاع المثلث؟',
    options: ['3', '4', '5', '6'],
    correctIndex: 0
  }
];

function generateRoomCode() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

// دالة إظهار النتيجة والانتقال للسؤال التالي
function revealAnswerAndNext(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.status !== 'playing') return;

  if (room.timer) clearTimeout(room.timer);

  const currentQ = room.questions[room.currentQuestionIndex];

  // 1. إرسال الإجابة الصحيحة للجميع
  io.to(roomCode).emit('answerResult', {
    correctIndex: currentQ.correctIndex
  });

  // 2. الانتظار 3 ثوانٍ ثم الانتقال للسؤال التالي
  setTimeout(() => {
    if (rooms[roomCode]) {
      rooms[roomCode].currentQuestionIndex++;
      startQuestionTimer(roomCode);
    }
  }, 3000);
}

// دالة مساعدة لإرسال الأسئلة بالتتابع وإدارة العداد
function startQuestionTimer(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  const currentQ = room.questions[room.currentQuestionIndex];

  if (!currentQ) {
    // انتهت الأسئلة -> إرسال النتائج النهائية
    endGame(roomCode);
    return;
  }

  // إعادة تصفير استجابات الأسئلة لهذه الدورة
  room.answersCount = 0;
  room.players.forEach(p => p.hasAnswered = false);

  // إرسال السؤال لجميع اللاعبين
  io.to(roomCode).emit('nextQuestion', {
    question: currentQ.question,
    options: currentQ.options,
    questionIndex: room.currentQuestionIndex + 1,
    totalQuestions: room.questions.length
  });

  // ⏱️ العداد التنازلي في السيرفر (30 ثانية لتطابق الفلاتر)
  room.timer = setTimeout(() => {
    revealAnswerAndNext(roomCode);
  }, 30000);
}

function endGame(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  if (room.timer) clearTimeout(room.timer);

  // ترتيب اللاعبين حسب النقاط
  const sortedScores = room.players
    .map(p => ({ name: p.name, score: p.score || 0 }))
    .sort((a, b) => b.score - a.score);

  io.to(roomCode).emit('gameOver', { scores: sortedScores });

  // إرجاع حالة الغرفة لمرحلة اللوبي
  room.status = 'lobby';
  room.currentQuestionIndex = 0;
}

io.on('connection', (socket) => {
  console.log('⚡ Player connected:', socket.id);

  // --- 0. إنشاء وإرسال Player ID فريد للعميل عند الاتصال ---
  const playerId = generatePlayerId();
  socket.playerId = playerId;
  socket.emit('your_player_id', { playerId: socket.playerId });

  socket.on('createVoiceRoom', (data = {}) => {
    const roomCode = generateUniqueRoomCode();
    const room = {
      roomCode,
      roomName: String(data.roomName || 'Voice Room').trim().slice(0, 40),
      roomType: String(data.roomType || 'عادي'),
      password: String(data.password || ''),
      maxMembers: Math.min(Math.max(Number(data.maxMembers) || 20, 2), 100),
      isPublic: data.isPublic !== false,
      music: null,
      host: socket.id,
      members: [{
        id: socket.id,
        playerId: socket.playerId,
        name: String(data.playerName || 'Guest').trim().slice(0, 30),
        isHost: true,
        isMuted: false,
        isSpeaking: false
      }]
    };

    voiceRooms[roomCode] = room;
    socket.join(roomCode);
    socket.voiceRoomCode = roomCode;
    socket.emit('voiceRoomCreated', voiceRoomSnapshot(room));
    emitVoiceRoomState(roomCode);
    console.log(`🎙️ Voice room ${roomCode} created by ${room.members[0].name}`);
  });

  socket.on('joinVoiceRoom', (data = {}) => {
    const roomCode = String(data.roomCode || '').trim();
    const room = voiceRooms[roomCode];
    if (!room) return socket.emit('voiceRoomError', 'الغرفة الصوتية غير موجودة');
    if (room.password !== String(data.password || '')) {
      return socket.emit('voiceRoomError', 'كلمة مرور الغرفة غير صحيحة');
    }
    if (room.members.length >= room.maxMembers) {
      return socket.emit('voiceRoomError', 'الغرفة الصوتية مكتملة');
    }

    const member = {
      id: socket.id,
      playerId: socket.playerId,
      name: String(data.playerName || 'Guest').trim().slice(0, 30),
      isHost: false,
      isMuted: false,
      isSpeaking: false
    };
    room.members.push(member);
    socket.join(roomCode);
    socket.voiceRoomCode = roomCode;
    socket.emit('voiceRoomJoined', voiceRoomSnapshot(room));
    socket.to(roomCode).emit('voiceRoomMemberJoined', member);
    emitVoiceRoomState(roomCode);
  });

  socket.on('voiceRoomAction', (data = {}) => {
    const roomCode = String(data.roomCode || '').trim();
    const room = voiceRooms[roomCode];
    const member = room?.members.find(item => item.id === socket.id);
    if (!room || !member) return socket.emit('voiceRoomError', 'لست داخل هذه الغرفة');

    const action = data.action;
    if (action === 'toggleMic') {
      member.isMuted = data.isMuted === true;
      emitVoiceRoomState(roomCode);
      return;
    }

    if (action === 'sendMessage') {
      const message = String(data.message || '').trim().slice(0, 300);
      if (message) {
        io.to(roomCode).emit('voiceRoomMessage', {
          senderId: socket.id,
          senderName: member.name,
          message,
          timestamp: Date.now()
        });
      }
      return;
    }

    if (action === 'musicChanged') {
      if (room.host !== socket.id) {
        return socket.emit('voiceRoomError', 'المضيف فقط يستطيع التحكم في موسيقى الغرفة');
      }
      room.music = {
        senderId: socket.id,
        track: data.track || null,
        isPlaying: data.isPlaying === true,
        positionMs: Number(data.positionMs) || 0,
        sentAt: Date.now()
      };
      io.to(roomCode).emit('voiceRoomMusicChanged', room.music);
      emitVoiceRoomState(roomCode);
      return;
    }

    if (action === 'requestMusicUpload') {
      if (room.host === socket.id) return;
      io.to(room.host).emit('voiceRoomMusicRequest', {
        requesterId: socket.id,
        requesterName: member.name
      });
      return;
    }

    if (action === 'musicRequestDecision') {
      if (room.host !== socket.id) return;
      const requesterId = String(data.requesterId || '');
      if (requesterId) {
        io.to(requesterId).emit('voiceRoomMusicDecision', {
          approved: data.approved === true,
          requesterId,
          message: data.approved === true
            ? 'تمت الموافقة على إضافة الموسيقى'
            : 'رفض المضيف إضافة الموسيقى'
        });
      }
      return;
    }

    if (['voiceOffer', 'voiceAnswer', 'voiceIceCandidate'].includes(action)) {
      const targetId = String(data.targetId || '');
      if (targetId) {
        io.to(targetId).emit(action, {
          senderId: socket.id,
          payload: data.payload
        });
      }
    }
  });

  socket.on('leaveVoiceRoom', (data = {}) => {
    removeVoiceMember(socket, String(data.roomCode || '').trim());
  });

  // 1. إنشاء غرفة
  socket.on('createRoom', (data) => {
    const roomCode = generateRoomCode();
    const playerName = data.playerName || 'Player 1';

    rooms[roomCode] = {
      host: socket.id,
      gameType: data.gameType || 'Default Game',
      maxPlayers: data.maxPlayers || 4,
      allowChat: data.allowChat ?? true,
      allowMic: data.allowMic ?? false,
      isPublic: data.isPublic ?? true,
      status: 'lobby',
      currentQuestionIndex: 0,
      answersCount: 0,
      questions: [],
      players: [
        { 
          id: socket.id, 
          playerId: socket.playerId,
          name: playerName, 
          isHost: true, 
          isReady: true, 
          score: 0, 
          hasAnswered: false 
        }
      ]
    };

    socket.join(roomCode);

    socket.emit('roomCreated', {
      roomCode: roomCode,
      roomConfig: rooms[roomCode],
      players: rooms[roomCode].players
    });

    console.log(`🎉 Room ${roomCode} Created (${data.gameType}) by ${playerName} (ID: ${socket.playerId})`);
  });

  // 2. الانضمام لغرفة
  socket.on('joinRoom', (data) => {
    const { roomCode, playerName } = data;
    const room = rooms[roomCode];

    if (!room) {
      return socket.emit('error', 'الغرفة غير موجودة!');
    }

    if (room.players.length >= room.maxPlayers) {
      return socket.emit('error', 'الغرفة مكتملة العدد!');
    }

    const newPlayer = {
      id: socket.id,
      playerId: socket.playerId,
      name: playerName || 'Guest',
      isHost: false,
      isReady: false,
      score: 0,
      hasAnswered: false
    };

    room.players.push(newPlayer);
    socket.join(roomCode);

    io.to(roomCode).emit('updatePlayers', room.players);
    socket.emit('roomJoined', {
      roomCode,
      roomConfig: room,
      players: room.players
    });
  });

  // 3. تغيير حالة Ready
  socket.on('toggleReady', (data) => {
    const { roomCode } = data;
    const room = rooms[roomCode];
    if (room) {
      const player = room.players.find(p => p.id === socket.id);
      if (player && !player.isHost) {
        player.isReady = !player.isReady;
        io.to(roomCode).emit('updatePlayers', room.players);
      }
    }
  });

  // 4. خروج اللاعب
  socket.on('leaveRoom', (data) => {
    const { roomCode } = data;
    const room = rooms[roomCode];
    if (room) {
      socket.leave(roomCode);
      room.players = room.players.filter(p => p.id !== socket.id);

      if (room.players.length === 0) {
        if (room.timer) clearTimeout(room.timer);
        delete rooms[roomCode];
      } else {
        if (room.host === socket.id) {
          room.host = room.players[0].id;
          room.players[0].isHost = true;
          room.players[0].isReady = true;
        }
        io.to(roomCode).emit('updatePlayers', room.players);
      }
    }
  });

  // 5. بدء اللعبة
  socket.on('startGame', (data) => {
    const { roomCode } = data;
    const room = rooms[roomCode];

    if (!room) return;

    if (room.host !== socket.id) {
      return socket.emit('error', 'الهوست فقط هو من يستطيع بدء اللعبة!');
    }

    const allReady = room.players.every(p => p.isHost || p.isReady);
    if (!allReady) {
      return socket.emit('error', 'يجب أن يكون جميع اللاعبين جاهزين (Ready) لبدء اللعبة!');
    }

    room.status = 'playing';
    room.currentQuestionIndex = 0;
    room.questions = [...sampleQuestions];
    room.players.forEach(p => {
      p.score = 0;
      p.hasAnswered = false;
    });

    io.to(roomCode).emit('gameStarted', {
      roomCode: roomCode,
      gameType: room.gameType
    });

    console.log(`🚀 Game Started in Room: ${roomCode}`);

    setTimeout(() => {
      startQuestionTimer(roomCode);
    }, 2000);
  });

  // 6. استقبال إجابات اللاعبين وحساب النتائج فوراً
  socket.on('submitAnswer', (data) => {
    const { roomCode, answerIndex } = data;
    const room = rooms[roomCode];

    if (!room || room.status !== 'playing') return;

    const player = room.players.find(p => p.id === socket.id);
    const currentQ = room.questions[room.currentQuestionIndex];

    if (player && !player.hasAnswered && currentQ) {
      player.hasAnswered = true;
      room.answersCount++;

      if (answerIndex === currentQ.correctIndex) {
        player.score = (player.score || 0) + 10;
      }

      if (room.answersCount >= room.players.length) {
        revealAnswerAndNext(roomCode);
      }
    }
  });

  socket.on('disconnect', () => {
    removeVoiceMember(socket, socket.voiceRoomCode);
    for (const code in rooms) {
      const room = rooms[code];
      const playerIndex = room.players.findIndex(p => p.id === socket.id);

      if (playerIndex !== -1) {
        room.players.splice(playerIndex, 1);

        if (room.players.length === 0) {
          if (room.timer) clearTimeout(room.timer);
          delete rooms[code];
        } else {
          if (room.host === socket.id) {
            room.host = room.players[0].id;
            room.players[0].isHost = true;
            room.players[0].isReady = true;
          }
          io.to(code).emit('updatePlayers', room.players);
        }
      }
    }
  });
});

function removeVoiceMember(socket, roomCode) {
  const room = voiceRooms[roomCode];
  if (!room) return;

  room.members = room.members.filter(member => member.id !== socket.id);
  socket.leave(roomCode);
  socket.voiceRoomCode = null;

  if (room.members.length === 0) {
    delete voiceRooms[roomCode];
    return;
  }

  if (room.host === socket.id) {
    room.host = room.members[0].id;
    room.members[0].isHost = true;
  }
  io.to(roomCode).emit('voiceRoomMemberLeft', socket.id);
  emitVoiceRoomState(roomCode);
}

// ✅ التعديل المهم جداً لبيئة Railway: إضافة '0.0.0.0'
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});