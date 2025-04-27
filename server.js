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
mongoose.connect('mongodb+srv://jjohanapriscy05:t7EimGaZPTkdRtNS@cluster0.7z856ay.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0/cycle_booking', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => console.log('MongoDB connected')).catch(err => console.error('MongoDB connection error:', err));

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
app.post('/api/register-or-login', async (req, res) => {
  const { email, password, role } = req.body;
  console.log(`Attempting login/register for email: ${email}, role: ${role}`);
  if (!email || !password || !role) {
    return res.status(400).json({ message: 'Missing required fields' });
  }

  const emailRegex = /^\d{9}@sastra\.ac\.in$/;
  if (!emailRegex.test(email.toLowerCase())) {
    return res.status(400).json({ message: 'Email must be a 9-digit number followed by @sastra.ac.in (e.g., 127156061@sastra.ac.in)' });
  }

  try {
    let user = await User.findOne({ email, role });
    if (!user) {
      console.log(`User not found, registering new user: ${email}`);
      if (!['user', 'host'].includes(role)) {
        return res.status(400).json({ message: 'Invalid role' });
      }
      const hashedPassword = await bcrypt.hash(password, 10);
      user = new User({ email, password: hashedPassword, role });
      await user.save();
      console.log(`New user registered: ${email} with role ${role}`);
    } else {
      console.log(`User found: ${email}, verifying password`);
      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) {
        console.log(`Password mismatch for ${email}`);
        return res.status(401).json({ message: 'Incorrect password. Please try again.' });
      }
    }

    const token = jwt.sign({ id: user._id, role: user.role }, 'secret_key', { expiresIn: '1h' });
    console.log(`Token generated for ${email}: ${token}`);
    res.json({ token, role });
  } catch (err) {
    console.error(`Error in register-or-login: ${err.message}`);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

app.get('/api/verify-token', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json({ role: user.role });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/logout', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (user) {
      res.json({ message: 'Logged out successfully' });
    } else {
      res.status(404).json({ message: 'User not found' });
    }
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/cycle-availability', async (req, res) => {
  const { place } = req.query;
  if (!place) {
    return res.status(400).json({ message: 'Place is required' });
  }

  try {
    const activeBookings = await Booking.find({
      place: place,
      started: true,
      stopped: false,
    });

    const cyclesInUse = activeBookings.map(booking => booking.cycle);
    const allCycles = ["Cycle 1", "Cycle 2", "Cycle 3"];
    const availability = allCycles.map(cycle => ({
      cycle: cycle,
      available: !cyclesInUse.includes(cycle),
    }));

    res.json(availability);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

app.post('/api/book', authenticateToken, async (req, res) => {
  if (req.user.role !== 'user') return res.status(403).json({ message: 'Unauthorized' });

  const { place, cycle } = req.body;
  try {
    const activeBooking = await Booking.findOne({
      place: place,
      cycle: cycle,
      started: true,
      stopped: false,
    });

    if (activeBooking) {
      return res.status(400).json({ message: `Cycle ${cycle} at ${place} is currently in use` });
    }

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
    io.emit('cycleStatusUpdate', { place: booking.place, cycle: booking.cycle, available: false });
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
    booking.duration = Math.floor((booking.endTime - booking.startTime) / 60000);
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
    io.emit('cycleStatusUpdate', { place: booking.place, cycle: booking.cycle, available: true });
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

app.post('/api/reset-password', async (req, res) => {
  const { email, newPassword, role } = req.body;
  if (!email || !newPassword || !role) {
    return res.status(400).json({ message: 'Email, new password, and role are required' });
  }

  const emailRegex = /^\d{9}@sastra\.ac\.in$/;
  if (!emailRegex.test(email.toLowerCase())) {
    return res.status(400).json({ message: 'Email must be a sastra email id' });
  }

  try {
    const user = await User.findOne({ email, role });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    user.password = hashedPassword;
    await user.save();

    res.json({ message: 'Password reset successful' });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
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
