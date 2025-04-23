const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Connection
mongoose.connect('mongodb://localhost:27017/cycle_booking', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => console.log('MongoDB connected')).catch(err => console.error(err));

// Models
const UserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['user', 'host'], required: true }
});
const User = mongoose.model('User', UserSchema);

const BookingSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  place: String,
  cycle: String,
  uniqueCode: String,
  started: { type: Boolean, default: false },
  stopped: { type: Boolean, default: false },
  startTime: Date,
  endTime: Date,
  duration: Number,
  cost: Number,
  dropLocation: String
});
const Booking = mongoose.model('Booking', BookingSchema);

const RideHistorySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  duration: Number,
  cost: Number,
  dropLocation: String,
  timestamp: { type: Date, default: Date.now }
});
const RideHistory = mongoose.model('RideHistory', RideHistorySchema);

// Utils
const generateUniqueCode = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
};

const calculateCost = (minutes) => {
  if (minutes <= 15) return 10;
  if (minutes <= 30) return 20;
  return 20 + Math.ceil((minutes - 30) / 30) * 39;
};

// JWT Middleware
const authenticateToken = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'No token provided' });

  jwt.verify(token, 'secret_key', (err, user) => {
    if (err) return res.status(403).json({ message: 'Invalid token' });
    req.user = user;
    next();
  });
};

// Routes
app.post('/api/register', async (req, res) => {
  const { email, password, role } = req.body;
  try {
    const existingUser = await User.findOne({ email });
    if (existingUser) return res.status(400).json({ message: 'User already exists' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ email, password: hashedPassword, role });
    await user.save();

    res.status(201).json({ message: 'User registered successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password, role } = req.body;
  try {
    const user = await User.findOne({ email, role });
    if (!user) return res.status(400).json({ message: 'Invalid credentials' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: 'Invalid credentials' });

    const token = jwt.sign({ id: user._id, role: user.role }, 'secret_key', { expiresIn: '1h' });
    res.json({ token, role });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/book', authenticateToken, async (req, res) => {
  if (req.user.role !== 'user') return res.status(403).json({ message: 'Unauthorized' });

  const { place, cycle } = req.body;
  try {
    const uniqueCode = generateUniqueCode();
    const booking = new Booking({
      userId: req.user.id,
      place,
      cycle,
      uniqueCode
    });
    await booking.save();

    io.emit('newBooking', booking);
    res.json({ booking, message: 'Cycle booked successfully', uniqueCode });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/bookings', authenticateToken, async (req, res) => {
  if (req.user.role !== 'host') return res.status(403).json({ message: 'Unauthorized' });

  try {
    const bookings = await Booking.find({ stopped: false }).populate('userId', 'email');
    res.json(bookings);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/start-ride', authenticateToken, async (req, res) => {
  if (req.user.role !== 'host') return res.status(403).json({ message: 'Unauthorized' });

  const { bookingId, uniqueCode } = req.body;
  try {
    const booking = await Booking.findById(bookingId);
    if (!booking || booking.uniqueCode !== uniqueCode) {
      return res.status(400).json({ message: 'Invalid booking or code' });
    }
    if (booking.started) return res.status(400).json({ message: 'Ride already started' });

    booking.started = true;
    booking.startTime = new Date();
    await booking.save();

    io.emit('rideStarted', { bookingId, startTime: booking.startTime });
    res.json({ message: 'Ride started' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/stop-ride', authenticateToken, async (req, res) => {
  if (req.user.role !== 'host') return res.status(403).json({ message: 'Unauthorized' });

  const { bookingId, dropLocation } = req.body;
  try {
    const booking = await Booking.findById(bookingId);
    if (!booking || !booking.started) {
      return res.status(400).json({ message: 'Invalid or not started booking' });
    }
    if (booking.stopped) return res.status(400).json({ message: 'Ride already stopped' });

    booking.stopped = true;
    booking.endTime = new Date();
    booking.duration = Math.floor((booking.endTime - booking.startTime) / 60000); // in minutes
    booking.cost = calculateCost(booking.duration);
    booking.dropLocation = dropLocation;
    await booking.save();

    const rideHistory = new RideHistory({
      userId: booking.userId,
      duration: booking.duration,
      cost: booking.cost,
      dropLocation
    });
    await rideHistory.save();

    io.emit('rideStopped', {
      bookingId,
      duration: booking.duration,
      cost: booking.cost,
      dropLocation
    });
    res.json({ message: 'Ride stopped', duration: booking.duration, cost: booking.cost });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/ride-history', authenticateToken, async (req, res) => {
  if (req.user.role !== 'user') return res.status(403).json({ message: 'Unauthorized' });

  try {
    const history = await RideHistory.find({ userId: req.user.id });
    res.json(history);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Socket.IO for Real-Time Updates
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('joinRide', (bookingId) => {
    socket.join(bookingId);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Start Server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));