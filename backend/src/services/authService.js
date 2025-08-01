const jwt = require('jsonwebtoken');
const { admin, db } = require('../config/firebase');
const config = require('../config/config');
const { logger } = require('../utils/logger');
const { FIREBASE_PATHS, MESSAGES, ROLES } = require('../config/constants');

class AuthService {

  async generateFirebaseToken(uid, claims = {}) {
    try {
      const customToken = await admin.auth().createCustomToken(uid, {
        role: claims.role,
        email: claims.email,
        phone: claims.phone,
        name: claims.name
      });
      
      logger.info(`Firebase custom token generated for uid: ${uid}`);
      return customToken;
    } catch (error) {
      logger.error('Firebase custom token generation error:', error);
      return null;
    }
  }

  async authenticateHost(firebaseUser) {
    const email = firebaseUser.email.toLowerCase();
    const role = config.allowedHosts[email];
    
    if (!role) {
      throw new Error(MESSAGES.ERROR.ACCESS_DENIED);
    }

    const user = {
      uid: firebaseUser.uid,
      email: email,
      name: firebaseUser.name || email,
      role: role
    };

    // Create session in database
    await db.ref(`${FIREBASE_PATHS.ACTIVE_HOSTS}/${user.uid}`).set({
      ...user,
      timestamp: Date.now()
    });

    // Clear session ended flag
    await db.ref(FIREBASE_PATHS.SESSION_ENDED).set(false);

    // Increment active host count
    await db.ref(FIREBASE_PATHS.ACTIVE_HOST_COUNT).transaction((current) => {
      return (current || 0) + 1;
    });

    // Generate JWT
    const token = jwt.sign(user, config.jwt.secret, {
      expiresIn: config.jwt.expiry
    });

    const firebaseToken = await this.generateFirebaseToken(user.uid, user);

    logger.info(`Host logged in: ${email}`);
    
    return { firebaseToken, token, user };
  }

  async authenticateParticipant(phone) {
    // Check whitelist and get user data
    const whitelistEntry = await db.ref(`${FIREBASE_PATHS.WHITELIST}/${phone}`).once('value');
    if (!whitelistEntry.exists()) {
      throw new Error(MESSAGES.ERROR.NOT_WHITELISTED);
    }

    // Handle both old format (phone: true) and new format (phone: {name: "...", source: "..."})
    const whitelistData = whitelistEntry.val();
    let name;
    
    if (typeof whitelistData === 'boolean' && whitelistData === true) {
      // Old format - backward compatibility
      throw new Error('Name not found in whitelist. Please contact administrator.');
    } else if (typeof whitelistData === 'object' && whitelistData.name) {
      // New format - extract name
      name = whitelistData.name;
    } else {
      // Invalid format
      throw new Error('Invalid whitelist entry format. Please contact administrator.');
    }

    // Validate extracted name
    if (!name || name.trim().length === 0) {
      throw new Error('Name not found in whitelist. Please contact administrator.');
    }

    // Check if already in session
    const activeSession = await db.ref(`${FIREBASE_PATHS.ACTIVE_SESSIONS}/${phone}`).once('value');
    if (activeSession.exists()) {
      throw new Error(MESSAGES.ERROR.ALREADY_IN_SESSION);
    }

    // Check if any host is active
    const hostCount = await db.ref('activeHostCount').once('value');
    if (!hostCount.exists() || hostCount.val() <= 0) {
      throw new Error(MESSAGES.ERROR.NO_ACTIVE_SESSION);
    }

    const user = {
      phone: phone,
      name: name.trim(),
      role: ROLES.PARTICIPANT,
      uid: phone // Using phone as UID for participants
    };

    // Create session
    await db.ref(`${FIREBASE_PATHS.ACTIVE_SESSIONS}/${phone}`).set(true);
    await db.ref(`${FIREBASE_PATHS.USERS}/${phone}`).set({
      ...user,
      timestamp: Date.now()
    });

    // Increment active participant count
    await db.ref(FIREBASE_PATHS.ACTIVE_PARTICIPANT_COUNT).transaction((current) => {
      return (current || 0) + 1;
    });

    // Generate JWT
    const token = jwt.sign(user, config.jwt.secret, {
      expiresIn: config.jwt.expiry
    });

    const sanitizedPhone = phone.replace(/[^0-9]/g, '');
    const participantUid = `participant_${sanitizedPhone}`; //sanitize before passing for token generation firebase

    // Generate Firebase custom token
    const firebaseToken = await this.generateFirebaseToken(participantUid, {
      ...user,
      uid: participantUid
    });

    logger.info(`Participant joined: ${name} (${phone}) - Name from whitelist`);

    return { firebaseToken, token, user };
  }

  async verifySession(token) {
    try {
      const decoded = jwt.verify(token, config.jwt.secret);
      let firebaseToken = null;
      try {
        firebaseToken = await this.generateFirebaseToken(decoded.uid, decoded);
      } catch (error) {
        logger.warn('Could not generate Firebase token during verify:', error.message);
      }

      return {
        valid: true, 
        user: decoded,
        firebaseToken
       };
    } catch (error) {
      return { valid: false };
    }
  }

  async logout(token) {
    try {
      const decoded = jwt.verify(token, config.jwt.secret);
      
      if (decoded.role === ROLES.PARTICIPANT) {
        await db.ref(`${FIREBASE_PATHS.ACTIVE_SESSIONS}/${decoded.phone}`).remove();
        
        // Decrement active participant count
        await db.ref(FIREBASE_PATHS.ACTIVE_PARTICIPANT_COUNT).transaction((current) => {
          return Math.max(0, (current || 0) - 1);
        });
      } else {
        // Remove host session
        await db.ref(`${FIREBASE_PATHS.ACTIVE_HOSTS}/${decoded.uid}`).remove();

        // Decrement active host count
        await db.ref('activeHostCount').transaction((current) => {
          return Math.max(0, (current || 0) - 1);
        }); 
      }

      logger.info(`User logged out: ${decoded.name}`);

    } catch (error) {
      logger.error('Logout error:', error);
    }
  }
}

module.exports = new AuthService();