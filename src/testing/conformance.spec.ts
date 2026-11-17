import { memoryRepository } from './memory-repository';
import { runRepositoryConformance } from './conformance';

/**
 * A suíte de conformidade rodando contra a semântica de referência. Se ela
 * falha aqui, o problema é da suíte — não do adapter que a estiver usando.
 */
runRepositoryConformance({
  name: 'memory (referência)',
  seed: async (model, rows) => memoryRepository({ [model]: rows }),
});
