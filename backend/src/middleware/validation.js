const Joi = require('joi');

// User validation schemas
const registerSchema = Joi.object({
  username: Joi.string()
    .alphanum()
    .min(3)
    .max(30)
    .required()
    .messages({
      'string.alphanum': 'Username must contain only letters and numbers',
      'string.min': 'Username must be at least 3 characters long',
      'string.max': 'Username must not exceed 30 characters'
    }),
  
  email: Joi.string()
    .email()
    .required()
    .messages({
      'string.email': 'Please provide a valid email address'
    }),
  
  password: Joi.string()
    .min(8)
    .pattern(new RegExp('^(?=.*[a-z])(?=.*[A-Z])(?=.*\\d)'))
    .required()
    .messages({
      'string.min': 'Password must be at least 8 characters long',
      'string.pattern.base': 'Password must contain at least one uppercase letter, one lowercase letter, and one number'
    }),
  
  timezone: Joi.string()
    .default('UTC')
    .messages({
      'string.base': 'Timezone must be a valid string'
    })
});

const loginSchema = Joi.object({
  email: Joi.string()
    .email()
    .required(),
  
  password: Joi.string()
    .required()
});

const refreshTokenSchema = Joi.object({
  refreshToken: Joi.string()
    .required()
});

// User profile update schema
const updateProfileSchema = Joi.object({
  username: Joi.string()
    .alphanum()
    .min(3)
    .max(30)
    .optional(),
  
  timezone: Joi.string()
    .optional()
});

// Group validation schemas (consolidated and updated)
// createGroupSchema is defined below, this is a good place for updateGroupSchema
const updateGroupSchema = Joi.object({
  name: Joi.string().min(3).max(50).optional().messages({
    'string.min': 'Group name must be at least 3 characters long',
    'string.max': 'Group name must not exceed 50 characters'
  }),
  description: Joi.string().max(200).allow('').optional(),
  type: Joi.string().valid('PUBLIC', 'PRIVATE').optional()
});

// Screen events validation
const screenEventSchema = Joi.object({
  event_type: Joi.string()
    .valid('LOCKED', 'UNLOCKED')
    .required(),
  
  timestamp: Joi.string()
    .isoDate()
    .required(),
  
  device_uuid: Joi.string()
    .required()
});

const batchEventsSchema = Joi.object({
  events: Joi.array()
    .items(screenEventSchema)
    .min(1)
    .max(1000)
    .required(),
  
  deviceCert: Joi.string()
    .optional()
});

// Group validation schemas
const createGroupSchema = Joi.object({
  name: Joi.string()
    .min(3)
    .max(50)
    .required()
    .messages({
      'string.min': 'Group name must be at least 3 characters long',
      'string.max': 'Group name must not exceed 50 characters'
    }),
  
  description: Joi.string()
    .max(200)
    .allow('')
    .optional(),
  
  type: Joi.string()
    .valid('PUBLIC', 'PRIVATE')
    .required()
});

const joinGroupSchema = Joi.object({
  inviteCode: Joi.string()
    .length(8)
    .pattern(/^[A-Z0-9]+$/)
    .optional() // Making both optional, route logic can decide if one is required
    .messages({
      'string.length': 'Invite code must be 8 characters long',
      'string.pattern.base': 'Invite code must be uppercase alphanumeric'
    }),
  groupId: Joi.string().uuid().optional() // Keep as UUID
}).or('inviteCode', 'groupId').messages({ // Ensure at least one is provided
  'object.missing': 'Either inviteCode or groupId must be provided'
});

const manageMemberSchema = Joi.object({
  userId: Joi.string().uuid().required(), // userId should be UUID
  action: Joi.string().valid('remove', 'promote', 'demote').required()
});

// Search validation
const searchUsersSchema = Joi.object({
  q: Joi.string()
    .min(2)
    .max(30)
    .required()
    .messages({
      'string.min': 'Search query must be at least 2 characters long'
    }),
  
  limit: Joi.number()
    .integer()
    .min(1)
    .max(20)
    .default(10)
});

const searchGroupsSchema = Joi.object({
  q: Joi.string()
    .min(2)
    .max(50)
    .required(),
  
  limit: Joi.number()
    .integer()
    .min(1)
    .max(20)
    .default(10)
});

// Pagination validation
const paginationSchema = Joi.object({
  page: Joi.number()
    .integer()
    .min(1)
    .default(1),
  
  limit: Joi.number()
    .integer()
    .min(1)
    .max(100)
    .default(20)
});

// Device registration schema
const deviceRegistrationSchema = Joi.object({
  deviceId: Joi.string()
    .required(),
  
  deviceModel: Joi.string()
    .required(),
  
  platform: Joi.string()
    .valid('ios', 'android')
    .required(),
  
  appSignature: Joi.string()
    .required()
});

// Parameter & Query Schemas
const groupIdParamSchema = Joi.object({
  groupId: Joi.string().uuid().required()
});

const eventLimitQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(50)
});

// Validation middleware factory
function validate(schema, property = 'body') {
  return (req, res, next) => {
    const { error, value } = schema.validate(req[property], { abortEarly: false });
    
    if (error) {
      const details = error.details.map(detail => ({
        field: detail.path.join('.'),
        message: detail.message
      }));
      
      return res.status(400).json({
        error: 'Validation failed',
        code: 'E400',
        details
      });
    }
    
    // Replace the original data with validated data (includes defaults)
    req[property] = value;
    next();
  };
}

module.exports = {
  validate,
  schemas: {
    register: registerSchema,
    login: loginSchema,
    refreshToken: refreshTokenSchema,
    updateProfile: updateProfileSchema,
    screenEvent: screenEventSchema,
    batchEvents: batchEventsSchema,
    // Group Schemas (createGroupSchema is already defined above this section in the file)
    createGroup: createGroupSchema,
    updateGroup: updateGroupSchema,
    joinGroup: joinGroupSchema,
    manageMember: manageMemberSchema,
    // Search Schemas
    searchUsers: searchUsersSchema,
    searchGroups: searchGroupsSchema,
    // Common Param/Query Schemas
    pagination: paginationSchema,
    deviceRegistration: deviceRegistrationSchema,
    groupIdParam: groupIdParamSchema,
    eventLimitQuery: eventLimitQuerySchema
  }
};
