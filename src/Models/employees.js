import mongoose from 'mongoose'


const employees = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    image_url: {
        type: String,
        default: null
    },

    email: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true
    },
    phone: {
        type: Number,
        required: true,
        unique: true,
    },
    password: {
        type: String,
        required: true,
        select: false
    },
    role: {
        type: String,
        enum: ["SUPER_ADMIN", "STAFF"],
        default: "STAFF",
    },
    permissions: [{
        type: String,
    }],
    status: {
        type: String,
        enum: ["ACTIVE", "INACTIVE"],
        default: "ACTIVE"
    },
    is_deleted: {
        type: Boolean,
        default: false
    },

    // Set on accounts created with an emailed random password
    mustChangePassword: {
        type: Boolean,
        default: false
    },
    // Tokens issued before this are rejected by auth middleware
    passwordChangedAt: Date,
    resetPasswordTokenHash: {
        type: String,
        select: false,
        index: { sparse: true }
    },
    resetPasswordExpires: {
        type: Date,
        select: false
    },

    lastLoginAt: Date,

},
    { timestamps: true }
)


export default mongoose.model("Employees", employees)