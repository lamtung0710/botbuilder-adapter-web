const mongoose = require('mongoose');

const botKitMessageWebSchema = new mongoose.Schema({

    MessageType: {
        type: String,
        enum: ["normal_text", "text", "image", "cards", "lists", "audio", "video", "file"],
        default: "normal_text"
    },

    Message: {
        type: mongoose.Schema.Types.Mixed,
        required: true
    },

    MessageFromBot: {
        type: Boolean,
        required: true
    },

    BotId: {
        type: Number,
    },

    ChannelId: {
        type: String,
    },
    sendBy: String,
}, {
    timestamps: {
        createdAt: "CreatedUTCDate",
        updatedAt: "ModifiedUTCDate"
    }
});

const botKitMessageWebModel = mongoose.model("BotKitMessageWeb", botKitMessageWebSchema);
export default botKitMessageWebModel;