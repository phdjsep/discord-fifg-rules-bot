require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const OpenAI = require('openai');

// Initialize Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
  ]
});

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Assistant Configuration
const ASSISTANT_ID = process.env.ASSISTANT_ID;

// Thread management
const userThreads = new Map();
const threadTimeouts = new Map();
const THREAD_TIMEOUT = 30 * 60 * 1000; // 30 minutes

// Define slash commands
const commands = [
  new SlashCommandBuilder()
    .setName('rules')
    .setDescription('Ask a question about the rules')
    .addStringOption(option => 
      option.setName('question')
        .setDescription('Your question about the rules')
        .setRequired(true)),
  new SlashCommandBuilder()
    .setName('reset')
    .setDescription('Reset your conversation with the bot'),
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Get information about how to use the bot')
];

// Start the bot
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  
  // Register slash commands with Discord
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  
  try {
    console.log('Started refreshing application (/) commands.');
    
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands },
    );
    
    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error(error);
  }
});

// Interaction handler (for slash commands)
client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;
  
  const { commandName } = interaction;
  
  if (commandName === 'rules') {
    const question = interaction.options.getString('question');
    const userId = interaction.user.id;
    
    try {
      // Acknowledge the interaction immediately to prevent timeout
      await interaction.deferReply();
      
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
        content: question
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
        await interaction.editReply(`Sorry, I encountered an issue while processing your request (${runStatus.status}).`);
        return;
      }
      
      // Get the messages from the thread
      const messages = await openai.beta.threads.messages.list(threadId);
      
      // Find the latest assistant message
      const assistantMessages = messages.data.filter(msg => msg.role === 'assistant');
      
      if (assistantMessages.length === 0) {
        await interaction.editReply("Sorry, I couldn't generate a response.");
        return;
      }
      
      // Process the response
      const latestMessage = assistantMessages[0];
      let responseText = '';
      
      // Process all content parts (text only)
      for (const content of latestMessage.content) {
        if (content.type === 'text') {
          responseText += content.text.value;
        }
      }
      
      // Send the response, splitting if necessary
      if (responseText.length <= 2000) {
        // Simple case: just send the text
        await interaction.editReply(responseText);
      } else {
        // Send first chunk as the reply
        await interaction.editReply(responseText.substring(0, 2000));
        
        // Send remaining chunks as follow-up messages
        for (let i = 2000; i < responseText.length; i += 2000) {
          const chunk = responseText.substring(i, Math.min(i + 2000, responseText.length));
          await interaction.followUp(chunk);
        }
      }
      
    } catch (error) {
      console.error('Error:', error);
      try {
        await interaction.editReply('Sorry, something went wrong while processing your request.');
      } catch (followUpError) {
        // If the interaction has already timed out, we need to create a new reply
        if (!interaction.replied) {
          await interaction.reply('Sorry, something went wrong while processing your request.');
        }
      }
    }
  } else if (commandName === 'reset') {
    const userId = interaction.user.id;
    
    if (userThreads.has(userId)) {
      userThreads.delete(userId);
      
      if (threadTimeouts.has(userId)) {
        clearTimeout(threadTimeouts.get(userId));
        threadTimeouts.delete(userId);
      }
      
      await interaction.reply('Your conversation has been reset. You can start a new conversation with `/rules`.');
    } else {
      await interaction.reply('You don\'t have an active conversation to reset.');
    }
  } else if (commandName === 'help') {
    const helpMessage = `
**Bot Commands:**
- \`/rules [question]\` - Ask me anything about the rules
- \`/reset\` - Start a fresh conversation
- \`/help\` - Show this help message
    `;
    await interaction.reply(helpMessage);
  }
});

// Login to Discord with your client token
client.login(process.env.DISCORD_TOKEN);

// Error handling
process.on('unhandledRejection', error => {
  console.error('Unhandled promise rejection:', error);
});