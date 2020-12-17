const dotenv = require("dotenv");
dotenv.config();
let config = {
    pathBotBuilderAPI: process.env.BOT_BUILDER_API_URL,
};
export default config;



