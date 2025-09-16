/**
 * Test Facet Server + Ollama Integration
 * 
 * This test verifies that:
 * 1. Facet server is running and accessible
 * 2. Ollama is running and accessible
 * 3. The integration between them works correctly
 * 4. Questions are generated with facet data
 */

import { generateQuestionsWithOllamaAndFacets } from './src/ollama_client.js';

async function testFacetServer() {
  console.log('🧪 Testing Facet Server...');
  
  try {
    const response = await fetch('http://localhost:8080/get_facet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gameId: 'barcelona-alaves-18-08-18',
        start: 0,
        end: 900,
        facet: 'FTT'
      })
    });
    
    if (!response.ok) {
      throw new Error(`Facet server returned ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json();
    console.log('✅ Facet server is working');
    console.log(`📊 Retrieved ${data.facet} facet data:`, JSON.stringify(data.data, null, 2));
    return true;
  } catch (error) {
    console.error('❌ Facet server test failed:', error.message);
    return false;
  }
}

async function testOllama() {
  console.log('\n🧪 Testing Ollama...');
  
  try {
    const response = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3.1:8b',
        prompt: 'Say "Hello from Ollama"',
        stream: false
      })
    });
    
    if (!response.ok) {
      throw new Error(`Ollama returned ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json();
    console.log('✅ Ollama is working');
    console.log(`🤖 Response: ${data.response}`);
    return true;
  } catch (error) {
    console.error('❌ Ollama test failed:', error.message);
    return false;
  }
}

async function testFacetOllamaIntegration() {
  console.log('\n🧪 Testing Facet + Ollama Integration...');
  
  try {
    // Create a mock user payload with game data
    const userPayload = {
      instructions: 'Generate exactly 2 betting questions for firstHalf of barcelona-alaves-18-08-18.',
      game: 'barcelona-alaves-18-08-18',
      window: { start: 0, end: 900 },
      stkm: {
        key_moments: [
          { player: 'Messi', action: 'shot', minute: 15 },
          { player: 'Alba', action: 'pass', minute: 20 }
        ],
        state: {
          shots: { home: 3, away: 1 },
          score: { home: 0, away: 0 }
        }
      }
    };
    
    const systemInstruction = 'You are a football analyst. Generate betting questions based on the game data provided.';
    
    console.log('📝 Generating questions with facet integration...');
    const result = await generateQuestionsWithOllamaAndFacets(systemInstruction, userPayload, 'llama3.1:8b');
    
    if (result.error) {
      throw new Error(`Integration failed: ${result.error.message}`);
    }
    
    console.log('✅ Facet + Ollama integration is working');
    console.log('📋 Generated questions:');
    console.log(result.text);
    
    // Check if the response contains questions
    if (result.text.includes('Question') && result.text.includes('A)') && result.text.includes('B)')) {
      console.log('✅ Questions are properly formatted');
      return true;
    } else {
      console.log('⚠️  Questions may not be properly formatted');
      return false;
    }
    
  } catch (error) {
    console.error('❌ Facet + Ollama integration test failed:', error.message);
    return false;
  }
}

async function testAllFacets() {
  console.log('\n🧪 Testing All Available Facets...');
  
  const facets = ['FTT', 'PTF', 'PAD', 'SPT', 'PCS', 'KH', 'MMH', 'NCMS'];
  const results = [];
  
  for (const facet of facets) {
    try {
      const response = await fetch('http://localhost:8080/get_facet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gameId: 'barcelona-alaves-18-08-18',
          start: 0,
          end: 900,
          facet: facet
        })
      });
      
      if (response.ok) {
        const data = await response.json();
        console.log(`✅ ${facet} facet working`);
        results.push({ facet, status: 'success', data: data.data });
      } else {
        console.log(`❌ ${facet} facet failed: ${response.status}`);
        results.push({ facet, status: 'failed', error: response.statusText });
      }
    } catch (error) {
      console.log(`❌ ${facet} facet error: ${error.message}`);
      results.push({ facet, status: 'error', error: error.message });
    }
  }
  
  const successCount = results.filter(r => r.status === 'success').length;
  console.log(`\n📊 Facet Test Results: ${successCount}/${facets.length} facets working`);
  
  return successCount === facets.length;
}

async function runAllTests() {
  console.log('🚀 Starting Facet Server + Ollama Integration Tests');
  console.log('='.repeat(60));
  
  const tests = [
    { name: 'Facet Server', fn: testFacetServer },
    { name: 'Ollama', fn: testOllama },
    { name: 'Facet + Ollama Integration', fn: testFacetOllamaIntegration },
    { name: 'All Facets', fn: testAllFacets }
  ];
  
  const results = [];
  
  for (const test of tests) {
    try {
      const result = await test.fn();
      results.push({ name: test.name, passed: result });
    } catch (error) {
      console.error(`❌ ${test.name} test crashed:`, error.message);
      results.push({ name: test.name, passed: false, error: error.message });
    }
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('📊 TEST RESULTS SUMMARY');
  console.log('='.repeat(60));
  
  results.forEach(result => {
    const status = result.passed ? '✅ PASS' : '❌ FAIL';
    console.log(`${status} ${result.name}`);
    if (result.error) {
      console.log(`   Error: ${result.error}`);
    }
  });
  
  const passedCount = results.filter(r => r.passed).length;
  const totalCount = results.length;
  
  console.log(`\n🎯 Overall: ${passedCount}/${totalCount} tests passed`);
  
  if (passedCount === totalCount) {
    console.log('🎉 All tests passed! Facet server + Ollama integration is working perfectly!');
  } else {
    console.log('⚠️  Some tests failed. Check the errors above.');
  }
  
  return passedCount === totalCount;
}

// Run the tests
runAllTests().catch(error => {
  console.error('❌ Test suite crashed:', error);
  process.exit(1);
});
