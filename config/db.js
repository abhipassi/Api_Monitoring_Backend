import mongoose from 'mongoose'

const connectDB = async () => {
    try {
        const connection = await mongoose.connect(
            process.env.MONGODB_URI
        );

        console.log(`MongoDb Connection Success ${connection.connection.host}`);

    }
    catch (error) {
        console.error("MongoDb Connection Failed :", error.message);
        throw error;
    }
}


export default connectDB;