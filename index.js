// Install these packages first:
// npm install discord.js openai dotenv

require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const OpenAI = require('openai');

// Initialize Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Your OpenAI Assistant ID
const assistantId = process.env.ASSISTANT_ID;

// Create a map to store thread IDs for each Discord channel
const threadMap = new Map();

client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);
});

client.on('messageCreate', async (message) => {
  // Ignore messages from bots
  if (message.author.bot) return;
  
  // Check if message is directed at the bot
  if (message.content.startsWith('!ask ')) {
    try {
      const query = message.content.slice(5).trim();
      
      // Get or create a thread for this channel
      let threadId = threadMap.get(message.channel.id);
      
      if (!threadId) {
        // Create a new thread
        const thread = await openai.beta.threads.create();
        threadId = thread.id;
        threadMap.set(message.channel.id, threadId);
      }
      
      // Add the user's message to the thread
      await openai.beta.threads.messages.create(threadId, {
        role: 'user',
        content: query
      });
      
      // Send a typing indicator while waiting for the response
      await message.channel.sendTyping();
      
      // Run the Assistant
      const run = await openai.beta.threads.runs.create(threadId, {
        assistant_id: assistantId
      });
      
      // Check the Run status
      let runStatus = await openai.beta.threads.runs.retrieve(threadId, run.id);
      
      // Poll for the response
      while (runStatus.status !== 'completed') {
        if (runStatus.status === 'failed') {
          await message.reply("Sorry, I couldn't process your request.");
          return;
        }
        
        // Wait for a bit before checking again
        await new Promise(resolve => setTimeout(resolve, 1000));
        runStatus = await openai.beta.threads.runs.retrieve(threadId, run.id);
      }
      
      // Get the messages from the thread
      const messages = await openai.beta.threads.messages.list(threadId);
      
      // Find the latest assistant message
      const assistantMessages = messages.data.filter(
        msg => msg.role === 'assistant'
      );
      
      if (assistantMessages.length > 0) {
        const latestMessage = assistantMessages[0];
        // Handle potential message types
        let responseText = '';
        
        for (const content of latestMessage.content) {
          if (content.type === 'text') {
            responseText += content.text.value;
          }
        }
        
        // Discord has a 2000 character limit for messages
        if (responseText.length <= 2000) {
          await message.reply(responseText);
        } else {
          // Split into multiple messages if needed
          for (let i = 0; i < responseText.length; i += 2000) {
            await message.channel.send(responseText.substring(i, i + 2000));
          }
        }
      }
    } catch (error) {
      console.error('Error:', error);
      await message.reply('Sorry, something went wrong.');
    }
  }
});

// Login to Discord
client.login(process.env.DISCORD_TOKEN);