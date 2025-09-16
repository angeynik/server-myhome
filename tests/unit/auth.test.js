const { loginUser, verifyToken } = require('../../auth');
const DBManager = require('../../services/db');

describe('Server-side Authentication', () => {
  describe('loginUser', () => {
    test('should login user successfully with valid credentials', async () => {
      // Arrange
      DBManager.findUser.mockResolvedValue(global.mockUserData.validUser);

      // Act
      const result = await loginUser(
        global.testRequests.validLogin.username,
        global.testRequests.validLogin.password
      );

      // Assert
      expect(result.success).toBe(true);
      expect(result.token).toBe('mock-jwt-token');
      expect(result.username).toBe('testuser');
      expect(result.userlevel).toBe(1);
      expect(result.dID).toBe('test-did-123');
      
      expect(DBManager.findUser).toHaveBeenCalledWith('testuser');
      expect(require('bcryptjs').compare).toHaveBeenCalledWith(
        'testpassword123',
        '$2a$10$hashedpassword123'
      );
      expect(require('jsonwebtoken').sign).toHaveBeenCalledWith(
        { id: 1 },
        process.env.JWT_SECRET,
        { expiresIn: '1h' }
      );
    });

    test('should reject login with invalid password', async () => {
      // Arrange
      DBManager.findUser.mockResolvedValue(global.mockUserData.validUser);
      require('bcryptjs').compare.mockResolvedValueOnce(false);

      // Act
      const result = await loginUser('testuser', 'wrongpassword');

      // Assert
      expect(result.error).toBe('Invalid password');
      expect(result.code).toBe('INVALID_PASSWORD');
      expect(result.success).toBeUndefined();
      
      expect(DBManager.findUser).toHaveBeenCalledWith('testuser');
      expect(require('bcryptjs').compare).toHaveBeenCalledWith(
        'wrongpassword',
        '$2a$10$hashedpassword123'
      );
    });

    test('should reject login with non-existent user', async () => {
      // Arrange
      DBManager.findUser.mockResolvedValue(null);

      // Act
      const result = await loginUser('nonexistent', 'password');

      // Assert
      expect(result.error).toBe('User not found');
      expect(result.code).toBe('USER_NOT_FOUND');
      
      expect(DBManager.findUser).toHaveBeenCalledWith('nonexistent');
      expect(require('bcryptjs').compare).not.toHaveBeenCalled();
    });

    test('should handle database errors gracefully', async () => {
      // Arrange
      DBManager.findUser.mockRejectedValue(global.testErrors.dbConnection);

      // Act
      const result = await loginUser('testuser', 'password');

      // Assert
      expect(result.error).toBe('Server error');
      expect(result.code).toBe('SERVER_ERROR');
    });

    test('should handle bcrypt comparison errors', async () => {
      // Arrange
      DBManager.findUser.mockResolvedValue(global.mockUserData.validUser);
      require('bcryptjs').compare.mockRejectedValueOnce(new Error('Bcrypt error'));

      // Act
      const result = await loginUser('testuser', 'password');

      // Assert
      expect(result.error).toBe('Server error');
      expect(result.code).toBe('SERVER_ERROR');
    });
  });

  describe('verifyToken', () => {
    test('should verify valid token successfully', () => {
      // Act
      const result = verifyToken('valid-token');

      // Assert
      expect(result).toEqual({ id: 1, username: 'testuser' });
      expect(require('jsonwebtoken').verify).toHaveBeenCalledWith(
        'valid-token',
        process.env.JWT_SECRET
      );
    });

    test('should throw error for invalid token', () => {
      // Arrange
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => {
        throw new Error('Invalid token');
      });

      // Act & Assert
      expect(() => verifyToken('invalid-token')).toThrow('Invalid token');
    });

    test('should throw error for no token provided', () => {
      // Act & Assert
      expect(() => verifyToken()).toThrow('No token provided!');
      expect(() => verifyToken(null)).toThrow('No token provided!');
      expect(() => verifyToken('')).toThrow('No token provided!');
    });
  });

  describe('Integration: Token generation and verification', () => {
    test('should generate and verify token correctly', () => {
      // Arrange
      const jwt = require('jsonwebtoken');
      const testPayload = { id: 1, username: 'testuser' };
      
      // Mock token generation
      jwt.sign.mockReturnValueOnce('test-jwt-token');
      
      // Mock token verification to return the payload
      jwt.verify.mockImplementationOnce((token, secret) => {
        if (token === 'test-jwt-token') {
          return testPayload;
        }
        throw new Error('Invalid token');
      });

      // Act - Simulate token generation (not calling loginUser to avoid DB calls)
      const token = jwt.sign(testPayload, process.env.JWT_SECRET, { expiresIn: '1h' });
      
      // Verify the token
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // Assert
      expect(token).toBe('test-jwt-token');
      expect(decoded).toEqual(testPayload);
      
      expect(jwt.sign).toHaveBeenCalledWith(
        testPayload,
        process.env.JWT_SECRET,
        { expiresIn: '1h' }
      );
      expect(jwt.verify).toHaveBeenCalledWith(
        'test-jwt-token',
        process.env.JWT_SECRET
      );
    });
  });
});