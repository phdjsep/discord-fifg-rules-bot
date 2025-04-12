require('dotenv').config();
const { Client, GatewayIntentBits, Events } = require('discord.js');
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

// Assistant Configuration
const ASSISTANT_ID = process.env.ASSISTANT_ID;
const PREFIX = '!ask'; // Command prefix

// Thread management
const userThreads = new Map();
const threadTimeouts = new Map();
const THREAD_TIMEOUT = 30 * 60 * 1000; // 30 minutes

// Start the bot
client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// Message handler
client.on(Events.MessageCreate, async (message) => {
  // Ignore messages from bots or without the prefix
  if (message.author.bot || !message.content.startsWith(PREFIX)) return;

  // Extract the query from the message
  const query = message.content.slice(PREFIX.length).trim();
  
  if (!query) {
    await message.reply('Please provide a question after the !ask command.');
    return;
  }

  // Get user ID (for thread management)
  const userId = message.author.id;
  
  try {
    // Send typing indicator
    await message.channel.sendTyping();
    
    // Reply to acknowledge receipt
    const statusMessage = await message.reply("I'm working on your request...");
    
    // Get or create thread for this user
    let threadId = userThreads.get(userId);
    
    if (!threadId) {
      // Create a new thread for user
      const thread = await openai.beta.threads.create();
      threadId = thread.id;
      userThreads.set(userId, threadId);
    }
    
    // Reset timeout for this thread
    if (threadTimeouts.has(userId)) {
      clearTimeout(threadTimeouts.get(userId));
    }
    
    // Set new timeout
    const timeout = setTimeout(() => {
      userThreads.delete(userId);
      threadTimeouts.delete(userId);
      console.log(`Thread for user ${userId} expired due to inactivity`);
    }, THREAD_TIMEOUT);
    
    threadTimeouts.set(userId, timeout);
    
    // Add the user's message to the thread
    await openai.beta.threads.messages.create(threadId, {
      role: 'user',
      content: query
    });
    
    // Run the Assistant
    const run = await openai.beta.threads.runs.create(threadId, {
      assistant_id: ASSISTANT_ID
    });
    
    // Poll for the response
    let runStatus = await openai.beta.threads.runs.retrieve(threadId, run.id);
    
    // Poll for completion
    while (runStatus.status !== 'completed' && 
           runStatus.status !== 'failed' && 
           runStatus.status !== 'cancelled' && 
           runStatus.status !== 'expired') {
      
      // Wait before checking again (500ms)
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Update run status
      runStatus = await openai.beta.threads.runs.retrieve(threadId, run.id);
    }
    
    // Check if run was successful
    if (runStatus.status !== 'completed') {
      console.error(`Run ended with status: ${runStatus.status}`);
      await statusMessage.edit(`Sorry, I encountered an issue while processing your request (${runStatus.status}).`);
      return;
    }
    
    // Get the messages from the thread
    const messages = await openai.beta.threads.messages.list(threadId);
    
    // Find the latest assistant message
    const assistantMessages = messages.data.filter(msg => msg.role === 'assistant');
    
    if (assistantMessages.length === 0) {
      await statusMessage.edit("Sorry, I couldn't generate a response.");
      return;
    }
    
    // Process the response
    const latestMessage = assistantMessages[0];
    let responseText = '';
    
    // Process all content parts (text only for simplified version)
    for (const content of latestMessage.content) {
      if (content.type === 'text') {
        responseText += content.text.value;
      }
    }
    
    // Delete the status message
    await statusMessage.delete();
    
    // Send the response, splitting if necessary
    if (responseText.length <= 2000) {
      // Simple case: just send the text
      await message.reply(responseText);
    } else {
      // Split text into chunks of 2000 characters
      for (let i = 0; i < responseText.length; i += 2000) {
        const chunk = responseText.substring(i, i + 2000);
        
        if (i === 0) {
          // First chunk as reply
          await message.reply(chunk);
        } else {
          // Subsequent chunks as follow-ups
          await message.channel.send(chunk);
        }
      }
    }
    
  } catch (error) {
    console.error('Error:', error);
    await message.reply('Sorry, something went wrong while processing your request.');
  }
});

// Add command to reset conversation
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  
  if (message.content.toLowerCase() === '!reset') {
    const userId = message.author.id;
    
    if (userThreads.has(userId)) {
      userThreads.delete(userId);
      
      if (threadTimeouts.has(userId)) {
        clearTimeout(threadTimeouts.get(userId));
        threadTimeouts.delete(userId);
      }
      
      await message.reply('Your conversation has been reset. Start a new conversation with `!ask`.');
    } else {
      await message.reply('You don\'t have an active conversation to reset.');
    }
  }
});

// Add help command
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  
  if (message.content.toLowerCase() === '!help') {
    const helpMessage = `
**Bot Commands:**
- \`!ask [your question]\` - Ask me anything
- \`!reset\` - Start a fresh conversation
- \`!help\` - Show this help message
    `;
    await message.reply(helpMessage);
  }
});

// Login to Discord with your client token
client.login(process.env.DISCORD_TOKEN);

// Error handling
process.on('unhandledRejection', error => {
  console.error('Unhandled promise rejection:', error);
});