import { createApp } from './app';

const PORT = process.env.PORT || 4000;

async function startServer() {
  try {
    console.log('🚀 Starting Chatbot API...\n');

    const app = await createApp();

    app.listen(PORT, () => {
      console.log('\n✓ Server running');
      console.log(`✓ Port: ${PORT}`);
      console.log(`✓ Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`✓ Health: http://localhost:${PORT}/health`);
      console.log(`✓ Chat: http://localhost:${PORT}/api/chat`);
      console.log(`✓ Upload: http://localhost:${PORT}/api/upload`);
      console.log('\n🎉 Ready!\n');
    });

    process.on('SIGTERM', () => {
      console.log('\n⏳ Shutting down...');
      process.exit(0);
    });

    process.on('SIGINT', () => {
      console.log('\n⏳ Shutting down...');
      process.exit(0);
    });
  } catch (error) {
    console.error('✗ Failed to start:', error);
    process.exit(1);
  }
}

startServer();