import bcrypt from "bcryptjs";
import Employees from "../Models/employees.js";
import generateToken from "../utils/generateToken.js";

export const adminLogin = async (req, res, next) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({
                success: false,
                message: "Email and password are required",
            });
        }

        const employee = await Employees.findOne({
            email: email.trim().toLowerCase(),
            status: "ACTIVE",
            is_deleted: false,
        }).select("+password");

        if (
            !employee ||
            !(await bcrypt.compare(password, employee.password))
        ) {
            return res.status(401).json({
                success: false,
                message: "Invalid email or password",
            });
        }

        employee.lastLoginAt = new Date();
        await employee.save();

        const token = generateToken({
            userId: employee._id.toString(),
            type: "admin",
        });

        return res.status(200).json({
            success: true,
            message: "Login successful",
            token,
            user: {
                id: employee._id,
                name: employee.name,
                email: employee.email,
                role: employee.role,
                permissions: employee.permissions,
                mustChangePassword: employee.mustChangePassword,
            },
        });
    } catch (error) {
        next(error);
    }
};



export const adminMe = (req, res) => {
    const employee = req.user.doc;

    return res.status(200).json({
        success: true,
        message: "Profile fetched",
        user: {
            id: employee._id,
            name: employee.name,
            email: employee.email,
            role: employee.role,
            permissions: employee.permissions,
            mustChangePassword: employee.mustChangePassword,
        },
    });
};
