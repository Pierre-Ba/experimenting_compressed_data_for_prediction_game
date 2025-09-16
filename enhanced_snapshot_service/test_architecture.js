/**
 * Test script to verify the architecture works
 * 
 * This script tests:
 * 1. Enhanced snapshot service receives and stores data
 * 2. Turn-based simulator can read the data
 * 3. Question generation works with Ollama
 */

import { TurnBasedSimulator } from './src/turn_based_simulator.js';

async function testArchitecture() {
  console.log('🧪 Testing Architecture...\n');
  
  // Test 1: Check if enhanced service is running
  try {
    const response = await fetch('http://localhost:7070/health');
    const data = await response.json();
    console.log('✅ Enhanced Snapshot Service is running:', data);
  } catch (error) {
    console.log('❌ Enhanced Snapshot Service is not running:', error.message);
    console.log('Please start it with: npm start');
    return;
  }
  
  // Test 2: Check if we have data
  try {
    const response = await fetch('http://localhost:7070/compressed_snapshots/barcelona-alaves-2018-08-18?count=1');
    const data = await response.json();
    console.log('✅ Data available:', data.count, 'snapshots');
    
    if (data.count === 0) {
      console.log('⚠️  No data available. Please run the replay server to populate data.');
      return;
    }
  } catch (error) {
    console.log('❌ Error checking data:', error.message);
    return;
  }
  
  // Test 3: Test turn-based simulator
  console.log('\n🎮 Testing Turn-Based Simulator...');
  const simulator = new TurnBasedSimulator();
  
  // Test question generation with existing data
  try {
    const snapshots = await simulator.getRecentSnapshots(900); // 15 minutes
    console.log('✅ Retrieved snapshots:', snapshots.length);
    
    if (snapshots.length > 0) {
      const questions = await simulator.generateQuestions(snapshots, 'firstHalf', 900);
      console.log('✅ Generated questions:', questions.length);
      
      if (questions.length > 0) {
        console.log('✅ Sample question:', questions[0].text);
      }
    }
  } catch (error) {
    console.log('❌ Error testing simulator:', error.message);
  }
  
  console.log('\n🎉 Architecture test completed!');
  console.log('\nTo run the full system:');
  console.log('1. Start enhanced service: npm start');
  console.log('2. Start replay server: node ../sb-replay-server.js ../barcelona-alaves-18-08-18.json');
  console.log('3. Start bridge: node ../snapshot_writer_service/bridge_sse_to_snapshot.js');
  console.log('4. Start simulator: npm run simulator barcelona-alaves-2018-08-18');
}

testArchitecture().catch(console.error);
